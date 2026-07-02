# EGHS — One-page PRD

## 1. Product Summary

**EGHS(Evidence-Gated Hook System)**는 Claude Code 세션에서 모델이 **충분한 파일 근거 없이 기존 파일을 수정하거나, 검증 실패 상태로 작업을 종료하는 것을 차단**하는 로컬 hook 기반 guardrail이다.

EGHS는 LLM verifier나 이론적 hallucination 판정을 사용하지 않는다. 판단 기준은 오직 다음 두 가지다.

1. **파일시스템 상태**: 기존 파일을 수정하기 전에 해당 파일을 `Read`했고, `Read` 시점의 SHA와 현재 SHA가 일치하는가.
2. **검증 명령 종료 코드**: Stop 시점에 typecheck/lint/test가 성공했는가.

EGHS의 목표는 "모델이 의미적으로 올바른 코드를 작성했는지"를 보장하는 것이 아니라, **명백히 위험한 작업 흐름을 deterministic하게 차단**하는 것이다.

---

## 2. Problem

Claude Code 기반 개발 세션에서 반복적으로 다음 문제가 발생한다.

| Failure Mode                                     | Impact                           |
| ------------------------------------------------ | -------------------------------- |
| 모델이 파일을 직접 읽지 않고 추측으로 Edit 수행                    | 잘못된 위치, 오래된 시그니처, 존재하지 않는 API 수정 |
| 파일을 Read한 뒤 디스크 상태가 바뀌었는데 stale context로 Edit 수행 | race condition, overwrite, 변경 손실 |
| typecheck/lint/test 실패 상태에서 작업 완료 선언             | 깨진 PR, CI 실패, 리뷰 비용 증가           |
| prompt-level discipline을 무시하고 수정 강행              | system prompt만으로는 작업 흐름 제어 불가    |

기존 LLM-as-verifier 방식은 latency, 비용, prompt injection, API key 노출, verifier hallucination 문제가 있다. EGHS는 이 접근을 폐기하고, **로컬 상태 검증과 외부 명령 exit code만 사용**한다.

---

## 3. Goals / Non-goals

### Goals

* **G1. Read 없는 기존 파일 Edit 차단**

  * `state_gate_paths`에 매칭되는 기존 파일의 `Write/Edit/MultiEdit`에 한정한다.
  * Read evidence는 현재 세션(sid) 소유여야 한다. 다른 세션의 evidence는 신뢰하지 않는다.
* **G2. Stale Read 차단**

  * Read 시점 SHA와 Edit 직전 SHA가 다르면 deny한다.
* **G3. Stop-time verification 강제**

  * typecheck/lint/test 중 설정된 명령이 실패하면 Stop을 block한다.
  * 검증을 우회/스킵하는 경로(예: stale lock, hook crash)는 fail-closed로 처리한다.
* **G4. 낮은 운영 비용**

  * LLM API 호출 없음, 로컬 hook + shell command만 사용.
* **G5. 즉시 비활성화 가능**

  * `.claude/eghs-off` 파일 또는 `EGHS_DISABLED=1`.
* **G6. 단계적 도입 가능**

  * Stop hook → prompt nudge → state writer → 좁은 path gate → 확장 순서로 rollout.

### Non-goals

* 코드 변경의 의미적 정확성 보장.
* LLM hallucination의 정보이론적 검증.
* Bash를 통한 파일 변경 직접 차단(후속 Edit의 SHA mismatch로만 간접 탐지).
* 같은 uid의 프로세스가 state를 위조하는 상황 방어.
* repo-controlled script의 RCE 방어.
* HMAC/암호학적 무결성 보장.
* Windows 지원.
* MultiEdit sub-edit 사이 race 방어(MultiEdit의 sub-edit 적용 순서/원자성은 Claude Code tool 구현에 의존하며 v5에서 별도 보호하지 않는다).
* **PreToolUse hook 종료 시점과 tool 실제 실행 시점 사이의 외부 파일 변경 방어.** v5는 이 window 내 외부 변경(다른 프로세스, 다른 사용자, OS 작업 등)으로 인한 silent overwrite를 막지 않는다. Claude Code tool이 compare-and-swap을 제공하지 않는 한 hook 단독으로는 보호 불가. 보호 의도는 "같은 세션 모델 자체의 stale-context 우발 오버라이트"에 한정한다.
* **신규 파일 Write의 OVERWRITE_RACE 완벽 검출.** PreToolUse 시점에 파일 부재였으나 tool 실행 사이에 외부에서 생성된 경우, R4 매트릭스로 best-effort 검출만 시도하며 false-negative을 허용한다. 운영자가 강한 보호를 원하면 Claude Code의 Write tool을 no-clobber 모드로 구성하거나 별도 lock을 도입한다.
* 모델 자신이 세션 중 `EGHS_DISABLED=1` 또는 `.claude/eghs-off`로 가드를 무력화하는 시나리오 방어. kill switch는 사용자(human) intent 전용이다. 운영 환경에서 모델 우회를 줄이려면 system prompt에서 kill switch 사용을 금지하고, `.claude/eghs-off`/config 파일 권한을 사용자 외 차단으로 운영한다.

---

## 4. Core Requirements

### R1. Prompt Discipline Injection

`UserPromptSubmit` hook은 다음 원칙을 `additionalContext`로 주입한다.

* 기존 파일 수정 전 대상 파일을 `Read`해야 한다.
* Bash 등 외부 경로로 파일이 변경된 경우 재차 `Read`해야 한다.
* Stop 전 설정된 verification을 통과해야 한다.

이 hook은 fail-soft로 동작한다. 실패하더라도 사용자 입력을 차단하지 않는다.

**출력 규칙**: hook은 `additionalContext`만 stdout으로 출력한다. 디버그/에러 메시지는 stderr로만 출력한다. stdout 오염 시 모델 입력이 깨지므로 엄격히 분리한다.

---

### R2. Read State Recording

`PostToolUse Read` hook은 파일별 SHA state를 기록한다.

State record (schema_version=1):

```json
{
  "schema_version": 1,
  "file": "<canonical-path>",
  "sha": "<sha256-hex>",
  "size": 12345,
  "ts_ms": 1780000000000,
  "sid": "<session-id>",
  "evidence": "full_read"
}
```

**Canonical path 정의**:

* `realpath(2)` 결과를 1차 정규화로 사용한다(symlink 해소, `.`/`..` 정규화).
* 파일시스템 case-sensitivity 감지: 결과는 `.claude/state/eghs/fs-info.json`에 1회만 캐시한다(아래 절차). hook은 매 호출마다 cache 파일을 stat만 한다(쓰기 없음). caseless FS(macOS APFS 기본, Windows NTFS 등)면 canonical key는 `lowercase(realpath)`, 그 외는 `realpath` 그대로 사용한다.
* cache 초기화 절차(installer/first-run helper가 수행, hook 내에서는 trigger만):
    1. `eghs-init`은 시작 시 `.claude/state/eghs/.init.lock`을 `O_CREAT|O_EXCL`로 획득한다(advisory flock 보조). 이미 존재하면 hold하는 프로세스가 살아있는지 확인하고 살아있으면 즉시 종료(exit 0, "already initialized 또는 in progress" stderr).
    2. `fs-info.json` 부재 시 `.cs-probe`/`.CS-PROBE` 파일을 atomic create 후 동일 inode 여부로 caseless 판정.
    3. 결과를 `{ "schema_version": 1, "caseless_fs": bool, "ts_ms": ... }`로 atomic write.
    4. probe 파일과 `.init.lock`을 즉시 삭제.
* hook이 `fs-info.json` 부재 발견 시: 같은 sid의 PreToolUse는 `FS_INFO_MISSING` deny(infrastructure, auto-unblock=Yes, remediation: `eghs-init` 실행). 첫 install에 사용자 명시 부트스트랩을 요구해 hook 내 race를 회피.
* `realpath` 실패 시(broken symlink, 권한 등) `FILE_UNREADABLE`로 처리한다.

**SHA 계산 대상**:

* 디스크 raw bytes의 SHA-256(소문자 16진수).
* line-ending normalization, line-numbering 없음.
* Read tool이 모델에게 line-numbered 형태로 반환하더라도 SHA는 디스크 원본 기준.

**Timestamp**:

* `ts_ms` = epoch milliseconds(monotonic 아님, `clock_gettime(CLOCK_REALTIME)`).
* `stale_after_seconds`(기본값 1800) 비교 시 `(now_ms - state.ts_ms) / 1000 > stale_after_seconds`.

**Read tool TOCTOU 처리**:

* `PostToolUse Read` hook은 디스크에서 다시 SHA를 계산하므로, Read tool이 본 내용과 PostToolUse 시점 디스크 상태 사이에 race window가 존재한다.
* PreToolUse Read hook도 SHA를 계산해 `pre/<sid>/<key>.read.json`에 임시 기록한다. PostToolUse Read는 이 값을 로드해 PostToolUse SHA와 비교한다.
* PreToolUse Read의 pre-record가 없거나(설치 미완료/비활성) SHA 비교가 불가하면, PostToolUse SHA만 단일 소스로 기록하되 이 race를 v5 허용 risk로 둔다(Risks §7).
* 비교 결과 mismatch면 `evidence: "stale_read"`로 기록하고 failed marker를 남긴다. `stale_read`는 R3 gate 통과 조건이 아니다.
* PreToolUse Read의 임시 record는 PostToolUse Read가 처리 후 즉시 삭제한다.

**파일 크기/부분 읽기 처리**:

* `partial_read` 판정 신호(아래 중 하나라도 해당):
    1. tool_input의 `offset` 또는 `limit` 인자가 명시되어 있다.
    2. 파일이 `max_full_read_bytes`(기본 5MB)를 초과한다.
* Claude Code 자체의 Read tool 응답 truncation flag는 v5 명세에 포함하지 않는다(필드 존재/이름이 버전별로 다름). truncation flag를 신뢰 신호로 추가하려면 후속 버전에서 명시적 reference와 함께 도입한다. 따라서 현 명세상 `max_full_read_bytes`(기본 5MB) 미만이면서 tool이 내부적으로 truncate한 케이스는 false-positive `full_read`로 분류될 수 있음을 **허용 risk**로 둔다(Risks §7).
* `partial_read`는 `sha: null`, `evidence: "partial_read"`로 기록하며 R3 gate 통과 조건이 아니다.
* 파일 줄 수 직접 측정은 hook에서 수행하지 않는다(latency 비용).

**Evidence 등급**:

* `full_read`: 전체 파일을 읽은 Read tool. R3 gate 통과 조건의 유일한 정답.
* `partial_read`: 부분 읽기 Read tool. gate 통과 불가.
* `stale_read`: TOCTOU 감지된 Read. gate 통과 불가, failed marker 동반.
* `grep_hit`: `Grep` tool. partial evidence, gate 통과 불가.
* `glob_hit`: `Glob` tool. existence evidence, gate 통과 불가.
* `post_edit_success`: Edit 성공 후 R4가 기록. gate 통과 조건이며 sid는 직전 Edit의 sid.
* `post_edit_partial`: Edit 부분 실패. gate 통과 불가, failed marker 동반.

State 기록 실패 시 failed marker를 남긴다. failed marker schema:

```json
{
  "schema_version": 1,
  "origin_sid": "<sid-that-failed>",
  "ts_ms": 1780000000000,
  "reason": "stale_read|state_record_failed|post_edit_partial|overwrite_race|migrate_in_progress|infra_not_ready|sid_collision|lease_unavailable|schema_invalid"
}
```

Marker 해제 정책 (**key-scoped 및 sid-scoped 모두 동일하게 적용**, 다음 중 하나):

* 같은 sid에서 같은 파일의 `full_read` 또는 `post_edit_success`가 성공적으로 기록됨(현재 세션 self-clear). PostToolUse Read 또는 PostToolUse Write/Edit/MultiEdit success가 R2/R4 정상 경로로 reads/state 갱신을 성공시키면, 직후 same-sid가 보유한 key-scoped marker(`failed/<sha1(key)>.json`) **및** sid-scoped marker(`failed/<current_sid>/<sha1(key)>.json`) 둘 다 unlink. unlink는 best-effort(ENOENT/EPERM silently skip; 잔존하면 다음 successful Read에서 재시도).
* Marker `ts_ms`가 **현 세션 `sessions/<sid>.json`의 `start_ms` 이전**이고, 현재 세션이 `full_read` 또는 `post_edit_success`를 성공적으로 기록함(stale marker self-clear). `start_ms`는 lease body의 immutable 필드이므로 #6.3b.4 stale-cleanup이 prior_start_ms를 보존한 경우 invariant 유지. 다른 세션이 만든 marker는 현 세션 `start_ms` 이전이어야만 자동 해제한다(sid-scoped marker에도 적용; `failed/<other_sid>/<sha1(key)>.json`은 origin_sid의 sessions GC와 cascade로 정리되며, R3 gate는 `failed/<current_sid>/...`만 검사하므로 다른 sid의 sid-scoped marker가 현 sid를 차단하지 않음).

후속 Edit은 marker 존재 시 `STATE_RECORD_FAILED`로 deny된다.

---

### R2.5. State Directory Layout

State는 `.claude/state/eghs/` 아래 다음 구조로 저장한다.

```
.claude/state/eghs/
├── schema_version            # **strict regex `^[1-9][0-9]*\n$` 최대 32바이트**(`12\n`), JSON wrapper 금지, 위반 시 INVALID. schema 변경 시 bump
├── fs-info.json              # case-sensitivity probe 결과 캐시(R2)
├── migrate.lock              # eghs-migrate 진행 중 잠금 (precedence #4)
├── .init.lock                # eghs-init 진행 중 잠금
├── tmp/<name>.<pid>.<seq>    # root-level atomic write temp (schema_version/fs-info.json 갱신용; eghs-init/eghs-migrate가 사용)
├── reads/
│   ├── <sha1(canonical_key)>.json   # R2 read/post-edit state record
│   └── tmp/<name>.<pid>.<seq>       # reads/ 전용 임시 파일(같은 dir rename)
├── failed/
│   ├── <sha1(canonical_key)>.json          # key-scoped marker(현 sid 영향)
│   ├── <sid>/<sha1(canonical_key)>.json    # sid-scoped marker(자기 sid에만 영향, cascade GC)
│   └── tmp/...
├── pre/
│   └── <sid>/<sha1(canonical_key)>.{write|read}.json   # R3/R2 PreToolUse 임시
├── locks/
│   └── stop-<sid>.lock       # Stop hook recursion lock (JSON: {pid, uid, start_ms, timeout_ms})
├── sessions/
│   ├── <sid>.json            # 세션 활성 lease (R5 baseline 작성, eghs-migrate 활성 sid 판정)
│   └── tmp/<sid>.<pid>.<seq> # atomic create/renew용 temp
├── baselines/
│   ├── <sid>.txt             # R5 diff baseline JSON {commit, lease_start_ms, lease_pid} — link(2) exclusive create
│   └── tmp/<sid>.<pid>.<seq> # link(2) source temp
├── verify-logs/
│   └── <sid>/
│       ├── typecheck.log
│       ├── lint.log
│       └── test.log
└── debug/
    └── <sid>.jsonl           # hook execution trace
```

* `canonical_key`는 R2의 case-aware 정규화 결과. 파일명은 `sha1(canonical_key)` 16진수.
* JSON state atomic write 절차(**destination-local temp**):
    1. 최종 경로와 같은 디렉토리 안에 `tmp/` 서브디렉토리를 만들고 `<basename>.<pid>.<seq>` 파일에 본문 쓰기. `seq`는 **per-write 단조 카운터**(hook 프로세스 내 글로벌). **dest dir 또는 `tmp/` 부재 시 `mkdir -p` (0700) on-demand 생성** — sid-scoped 경로(`failed/<sid>/`, `failed/<sid>/tmp/`, `pre/<sid>/`, `pre/<sid>/tmp/`)는 hook이 첫 write 시 lazy 생성. root-level(`tmp/`, `reads/tmp/`, `failed/tmp/`, `sessions/tmp/`, `baselines/tmp/`)은 eghs-init이 미리 생성하므로 on-demand 진입 안 됨(부재 시 #5c가 INFRA_NOT_READY로 차단).
    2. `fsync(fd)`.
    3. `rename(2)`로 최종 경로(상위 dir)로 이동. tmp가 상위 dir의 서브이므로 같은 파일시스템 보장.
    4. 상위 dir에 대해 `fsync(dirfd)`. 같은 파일시스템 내 cross-subdir rename이므로 상위 dir만 fsync로 충분(POSIX 권장).
    5. 같은 파일시스템 내 cross-subdir(`<dest_dir>/tmp/` → `<dest_dir>/`) atomic rename으로 보장된다.
* `pre/<sid>/` 디렉토리:
    * PreToolUse Write/Edit/MultiEdit은 `*.write.json`에 대상 파일 직전 SHA(`pre_sha`)와 PreToolUse sid(`pretool_sid`)를 기록한다.
    * PreToolUse Read는 `*.read.json`에 PreToolUse 시점 SHA를 기록한다.
    * lifecycle: PostToolUse가 동일 sid+path의 pre file을 로드해 결정 후 삭제한다.
    * Deny 시(특히 `OVERWRITE_RACE`/`STATE_RECORD_FAILED`)에도 PreToolUse hook은 본인이 만든 `pre/` 파일을 즉시 삭제한다(poisoned pre_sha 방지).
    * GC: hook 시작 시 24시간 초과된 `pre/<sid>/` 파일을 삭제한다.
* `sessions/<sid>.json` 내용: `{ "schema_version": 1, "pid": <claude-code-pid>, "start_ms": ..., "uid": ..., "renewed_ms": ... }`.
    * **claude-code-pid 획득 규약**: hook은 자체 PID(`getpid()`) 대신 **부모 Claude Code 프로세스의 PID**를 사용한다. 우선순위:
        1. 환경변수 `CLAUDE_CODE_PID`가 set + 유효 정수 + `kill(pid, 0)` 성공이면 사용(Claude Code가 hook spawn 시 명시 주입한 값).
        2. fallback: `getppid()` 결과 사용. 단 hook이 shell wrapper 통해 spawn된 경우 `getppid()`가 shell PID를 반환할 수 있어 부정확 risk가 있으므로 환경변수 주입을 권장(rollout §6에서 명시).
        3. 어느 쪽도 dead(`kill(pid, 0)` ESRCH)면 `INFRA_NOT_READY` 후보 → #4 매트릭스.
    * lease가 사용하는 pid는 hook lifecycle 내내 동일해야 한다(여러 hook 호출이 같은 Claude Code 세션에서 같은 pid를 보고해야 SID_COLLISION 미감지 방지).
    * Hook은 R6 precedence #6에서 lease를 atomic create/renew한다(kill switch, CI passthrough, migrate.lock 매트릭스, recover.lock GC, schema 정합성 확인 모두 통과 후).
    * GC 정책(**R6 precedence #5에서 수행**, kill switch/CI passthrough 통과 후): 다음 조건을 **모두** 만족하는 lease만 삭제. "hook 시작 시" 자동이 아니라 #5에서 수행해야 G5 disk-leak 방지 invariant 유지.
        1. `renewed_ms`가 `session_stale_seconds`(기본 86400) 경과.
        2. lease의 `uid`가 현재 hook 프로세스 uid와 같음.
        3. `pid` 프로세스가 dead(`kill(pid, 0)` ESRCH).
        GC 시 같은 sid의 baselines/<sid>.txt + verify-logs/<sid>/ + debug/<sid>.jsonl + pre/<sid>/ + failed/<sid>/ cascade unlink(eghs-migrate와 동일 정책).
    * Foreign-uid 또는 EPERM 케이스: 자동 GC는 lease를 건드리지 않는다. multi-user 환경에서 죽은 다른 uid lease가 영구 잔존하면 `eghs-migrate --force-foreign-cleanup`(admin 옵션)으로 수동 정리한다. `--force-foreign-cleanup`은 `migrate.lock` 획득 후 모든 foreign-uid lease 중 `renewed_ms`가 `session_stale_seconds × 2` 초과한 것만 삭제한다(보수적).
    * `eghs-migrate`는 `sessions/` 디렉토리가 비어있을 때만 동작한다(GC 후 평가). `locks/`도 비어 있어야 한다.
* `locks/stop-<sid>.lock` 내용 JSON `{pid, uid, start_ms, timeout_ms}`. recursion만 막는다.
    * **Exclusive lock 획득 절차** (R2.5 atomic-write의 rename-overwrite 의미와는 다름):
        1. 후보 본문(`{pid, uid, start_ms, timeout_ms}`)을 `locks/tmp/stop-<sid>.<pid>.<seq>`에 쓰고 fsync.
        2. 최종 경로 `locks/stop-<sid>.lock`을 `link(2)`(hardlink)로 옮긴다. `link`는 destination이 이미 존재하면 EEXIST로 실패하므로 exclusive 획득 신호로 활용.
        3. EEXIST면 lock이 이미 존재. stale 회수 절차(아래) 후 재시도 1회. 그래도 EEXIST면 **block 반환**(fail-closed).
        4. link 성공 시 tmp 파일은 unlink. 상위 dir fsync.
        5. Lock 해제 시 own pid 확인 후 unlink.
    * Stale lock 회수 절차:
        1. lock의 `uid`가 현재 프로세스 uid와 다르면 stale 판정 불가 → block 반환(fail-closed).
        2. `kill(pid, 0)`이 ESRCH면 dead로 판정. ESRCH 외에 same-uid EPERM이 발생하면(PID namespace/sandbox 등 비정상 case) stale 판정 불가 → block.
        3. `start_ms + timeout_ms + grace_ms`(기본 5000) 경과면 dead로 판정.
        4. dead 판정 시 회수 절차 — **TOCTOU 방지**:
           a. 회수 보조 lock `locks/tmp/stop-<sid>.recover.<pid>.<seq>`에 본문 `{pid, uid, start_ms, recovery_grace_ms}`(기본 grace 60s)를 fsync 후 `link(2)`로 `locks/stop-<sid>.recover.lock`에 옮긴다.
           b. EEXIST 시: 기존 recover.lock 본문을 stat+open. 본문 파싱 실패 또는 type 비정상이면 본 시도 중단(block 반환).
              * 본문 `uid` != 현재 uid → 다른 사용자 회수자, block 반환.
              * 본문 `uid` == 현재 uid이고 `kill(body.pid,0)` ESRCH이며 `body.start_ms + body.recovery_grace_ms` 경과 → **recover.lock 자체 stale** 판정, unlink 후 4a부터 재시도 1회. 재시도도 실패하면 block 반환.
              * 그 외(살아있는 다른 회수자) → block 반환.
           c. recover.lock 획득 후 stale lock 본문을 re-stat해 동일 inode/`start_ms`인지 검증. 다르면(다른 회수자가 이미 처리) recover.lock unlink 후 본 link 절차로 새 lock 획득 시도.
           d. 동일하면 stale lock unlink 후 본 link 절차로 새 lock 획득.
           e. 본 lock 획득 성공 시 recover.lock unlink. 절차 중 어떤 단계든 실패하면 보조 lock 정리 후 block 반환.
        5. **recover.lock 진입형 GC**: R6 precedence **#5**(kill switch와 CI passthrough 통과 이후)에서 best-effort 수행. 절차는 R6 #5 참조. kill switch 환경에서는 이 mutation도 발생하지 않는다(G5 보장).
    * `eghs-migrate` precondition은 `locks/`가 다음 중 하나여야 한다: (a) 디렉토리 부재, (b) 비어 있음, (c) **모든 잔존 `stop-<sid>.lock` 및 `stop-<sid>.recover.lock`의 대응 sid lease가 sessions/에 없거나 dead lease**. (c) 조건이면 eghs-migrate가 **step 4 sessions/ GC 직후**(역할 검증=step 3 다음) 해당 lock 파일들을 best-effort unlink하고 진행한다(같은 GC pass에서 orphan으로 확정된 lock만 삭제). 살아있는 lease를 가진 lock이 단 하나라도 있으면 종료.
* `debug/<sid>.jsonl`은 GC: `verify-logs/`와 동일 정책. `sessions/<sid>.json` lease가 부재(GC됨)이고 mtime이 `verify_logs_stale_seconds`(기본 7일) 경과면 삭제.
* `verify-logs/`는 GC: **R6 precedence #5b (sessions/ GC와 같은 pass)에서 수행**. G5 invariant(no mutation in #1~#3) 준수. 다음 모두 만족하면 삭제.
    * 디렉토리 mtime이 `verify_logs_stale_seconds`(기본 7일) 경과.
    * 대응 `sessions/<sid>.json` lease가 부재(GC됨).
    * `baselines/<sid>.txt`도 부재(또는 함께 삭제).
  즉, `verify-logs/`와 `baselines/`는 항상 `sessions/<sid>` GC 시점에 함께 삭제되어 desync 방지(cascade는 #5b sessions GC가 책임).
* `reads/tmp/`, `failed/tmp/`: GC 시 1시간 초과 임시 파일 삭제.
* `reads/<sha1(key)>.json`: GC 시 다음 모두 만족하면 삭제.
    * state의 `ts_ms`가 `read_state_stale_seconds`(기본 30일) 경과.
    * state의 `sid`가 `sessions/`에 없음(해당 세션 GC됨).
    * 디스크에 canonical path 파일이 부재하거나, 디스크 SHA가 state.sha와 불일치(이미 stale).
* `failed/<sha1(key)>.json`: GC 시 다음 모두 만족하면 삭제.
    * marker의 `ts_ms`가 `failed_marker_stale_seconds`(기본 30일) 경과.
    * marker의 `origin_sid`가 `sessions/`에 없음.
* `baselines/<sid>.txt`: precedence #6에서 schema가 healthy인 경우에만 anchor-bound 절차로 작성(JSON `{"commit": "...", "lease_start_ms": ..., "lease_pid": ...}`). 자세한 절차는 #6.3 참조. GC: 대응 `sessions/<sid>.json`이 삭제될 때 함께 삭제.

**Schema versioning (동시 세션 안전)**:

* 첫 install에서 `schema_version` 파일 부재면 **부트스트랩 모드**: `eghs-init`이 현재 코드 버전을 atomic write로 기록하고 정상 동작 진입. hook 내에서 자동 생성하지 않음(race 회피). hook이 부재를 발견하면 `INPUT_PARSE` 친화의 `SCHEMA_NOT_INITIALIZED` deny(infrastructure, auto-unblock=Yes, remediation: `eghs-init` 실행).
* `schema_version` 파일이 현재 hook 코드 버전보다 **낮으면**(upgrade pending) hook은 **read-only fallback 모드**:
    * `PreToolUse Write/Edit/MultiEdit`은 `SCHEMA_MISMATCH` deny(자동 우회 금지).
    * `Stop` hook은 verification command만 수행(state 무관).
    * `PostToolUse`/`UserPromptSubmit`/`PostToolUse Read`는 state를 쓰지 않는다.
* `schema_version` 파일이 현재 코드보다 **높으면**(downgrade): 동일하게 `SCHEMA_MISMATCH`, 사용자 안내(코드 upgrade 또는 명시적 downgrade migrate 요구).
* 사용자는 `eghs-migrate` CLI로 state dir을 정리하고 schema_version을 갱신한다. 자동 삭제 금지.
* **`eghs-init` ↔ `eghs-migrate` mutex (init/migrate 동시 실행 차단)**:
    * **공유 lock**: 두 CLI 모두 `migrate.lock`을 acquire한다. `.init.lock`은 init 내부 단계(probe → fs-info.json 작성) 보호용이며, init/migrate 간 mutex는 `migrate.lock`이 단일 진실.
    * **역할 검증** (lock 획득 직후):
        * `eghs-init`은 `schema_version` 파일이 **부재**여야만 진행. 존재 시 stderr `[eghs-init] schema_version already exists; use eghs-migrate to upgrade` 출력 후 lock 해제, 비-zero exit.
        * `eghs-migrate`는 `schema_version` 파일이 **존재**해야만 진행. 부재 시 stderr `[eghs-migrate] schema_version absent; use eghs-init to bootstrap` 출력 후 lock 해제, 비-zero exit.
        * `eghs-init --repair`는 다음 두 케이스에 한해 허용:
            1. `schema_version` **존재하지만 INVALID**(strict regex 위반).
            2. `schema_version` 정상이지만 state subdir 하나 이상 부재(부분 초기화/수동 삭제 회복).
          두 케이스 모두: subdir mkdir -p (idempotent) + 1번 케이스이면 schema_version atomic rewrite. 정상 schema + 모든 subdir 존재인 상태에서 `--repair` 호출은 no-op + exit 0(idempotent). plain `eghs-init`은 두 케이스 모두 거부, `eghs-migrate`도 거부(stderr 안내).
* `eghs-init` 동작 절차(`migrate.lock` mutex 포함):
    1. `migrate.lock` stale 회수: hook precedence #4 stale rule을 적용. 다른 uid 또는 살아있는 lock 시 종료.
    2. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득. lock 내용 `{pid, uid, start_ms, role: "init"}`.
    3. 역할 검증: `schema_version` 부재 확인 (또는 `--repair` 플래그 + (INVALID 또는 정상 schema + state subdir 일부 부재 또는 정상 schema + 모든 subdir 정상=no-op)). 위 mutex 정의 일치.
    4. `.init.lock` acquire(내부 단계 보호).
    5. **State subdir 생성** (mkdir -p, 모두 존재해야 hook이 INFRA_NOT_READY 없이 진행):
       * `tmp/` (root-level, schema_version/fs-info.json atomic write용)
       * `reads/`, `reads/tmp/`
       * `failed/`, `failed/tmp/`
       * `pre/`
       * `locks/`, `locks/tmp/`
       * `sessions/`, `sessions/tmp/`
       * `baselines/`, `baselines/tmp/`
       * `verify-logs/`
       * `debug/`
       모든 디렉토리는 0700 권한으로 생성(권한 운영 가이드 §R6).
    6. `fs-info.json` 부재 시 probe 절차(R2 참조)로 생성.
    7. `schema_version`을 R2.5 atomic write로 작성(**strict 형식 `^[1-9][0-9]*\n$` 최대 32바이트**; 코드 버전 ≥ 1). `0\n`이나 선행 0(`01\n`) 금지 — precedence #1 reader와 동일 규칙. **반드시 5/6단계 완료 후에 schema_version을 마지막으로 작성**(schema 존재 = 모든 인프라 준비 완료의 단일 signal).
    8. probe 파일, `.init.lock`, `migrate.lock` 순서로 삭제.
* `eghs-migrate` 동작 절차:
    1. `migrate.lock` stale 회수: 기존 `migrate.lock`이 있으면 hook의 precedence #4 stale rule(same uid + dead + grace 경과)을 그대로 적용. 다른 uid lock 또는 살아있는 lock 시 종료. migrate.lock이 regular file이 아닌 비정상 type이면 stderr에 `[eghs-migrate] migrate.lock is not a regular file; aborting` 출력 후 비-zero exit.
    2. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득. lock 내용 `{pid, uid, start_ms, role: "migrate"}`.
    3. 역할 검증: `schema_version` 존재 + 파싱 성공 확인(INVALID이면 종료, init 안내).
    4. lock 획득 후 `sessions/` 디렉토리를 GC 절차(pid liveness + uid + TTL)로 정리. `--force-foreign-cleanup` 플래그가 있으면 foreign-uid stale lease도 정리. **각 GC된 sid에 대해 cascade delete**: `baselines/<sid>.txt` unlink, `verify-logs/<sid>/` `rm -rf`, `debug/<sid>.jsonl` unlink, `pre/<sid>/` `rm -rf`, `failed/<sid>/` `rm -rf`(orphan sid-scoped marker도 정리). **모두 best-effort**: ENOENT와 EPERM 둘 다 silently skip(foreign-uid 파일 cleanup 권한 부족 시 orphan으로 남겨두고 다음 GC pass에서 표면화). EPERM이 발생한 sid는 sessions/<sid>.json 자체 unlink도 함께 skip해 cascade desync 차단(sessions GC와 cascade cleanup의 원자성 보존).
    5. `sessions/`가 비어 있고 `locks/` precondition(상기 stop/recover lock 규칙)이 만족되면 schema 갱신 진행. 비어 있지 않으면 사용자에게 활성 세션 안내 후 lock 해제하고 종료.
    6. **Per-record schema 정리** (schema bump 시 v→v+1 마이그레이션): bump이면 다음을 수행 후 schema_version 파일 갱신.
        * `reads/*.json` 전체 unlink(GC TTL 무시, 즉시 삭제). cross-session evidence는 schema 변경 시 무효화하는 것이 가장 안전(evidence 손실은 다음 Read에서 재생성됨; G1 일관성 유지가 우선).
        * `failed/*.json` 전체 unlink(동일 이유).
        * `fs-info.json`은 schema-agnostic이므로 유지(단, fs-info schema_version 필드도 동일하게 bump하려면 `eghs-init --repair` 호출 안내).
        * 본 단계는 trace 모드(`--dry-run`)로 사전 검토 가능해야 한다(MVP 도구 §8).
        이 정책은 per-record body의 `schema_version` 필드 호환성 처리 코드를 hook에서 제거할 수 있게 해 단순성/안전성을 모두 확보한다. record의 자체 `schema_version` 필드는 디버깅/감사용으로만 유지하며, hook 동작 분기에는 사용하지 않는다.
    7. schema 갱신은 R2.5 atomic write 절차(destination-local tmp + fsync + same-dir rename + dir fsync)로 `schema_version` 파일을 갱신한다. 비-atomic truncate+write 금지.
    8. schema 갱신 완료 후 `migrate.lock` 삭제.
* hook은 매 호출 precedence #4에서 `migrate.lock`을 체크해 `eghs-migrate` 진행 중에는 hook-type 매트릭스에 따라 분류한다. 이는 `eghs-migrate` 본인의 lock 절차와 결합해 race를 차단.
* **Precedence #1 ↔ #6 TOCTOU 방어**: hook은 precedence #6(lease write) 직전에 `migrate.lock`을 재확인하고, lock이 존재하면 후보 `MIGRATE_IN_PROGRESS` → #4 매트릭스 적용. 또한 `disk_schema`를 #6에서 재읽기해 #1 시점 값과 다르면 동일 처리. 이로써 #1과 #6 사이에 migrate가 완주한 race도 안전하게 처리.

**Cross-session 정책**:

* `reads/`는 모든 세션이 공유한다. R3 gate는 state의 `sid` 필드가 현재 hook 호출의 sid와 일치할 때만 통과시킨다(G1).
* 즉, 다른 세션의 Read evidence는 사용하지 않는다. 같은 세션이 동일 파일을 Read하면 state를 갱신해 sid를 자기 것으로 채운다.
* failed marker는 sid + ts_ms tagged(R2 schema 참조). 다른 세션이 만든 marker는 현 세션 `sessions/<sid>.json`의 immutable `start_ms`보다 이전인 경우에만 self-clear 가능. 더 신 marker는 그 세션에서만 해제할 수 있다.

**sid 형식 규약**:

* `sid`는 **UUIDv4 lowercase string**(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)이어야 한다. Claude Code 본체가 제공하는 session_id가 이 형식을 만족한다고 가정한다.
* hook은 input의 `session_id`를 strict regex로 검증한다. 위반 시 `NO_SESSION` 신호로 처리(R3 enum 참조)하여 state write 차단.
* 이는 sid 충돌(누군가가 GC된 sid를 재사용) risk를 무력화하기 위함(UUIDv4 collision 확률 무시 가능).
* **Baseline reuse 가드**: precedence #6.3a/b/c 절차에 정식 명세. anchor는 baseline body의 `lease_start_ms` + `lease_pid` 필드(sessions/<sid>.json과 동일). 이는 GC 누락 + UUIDv4 충돌(이론적) + 동시 sid 점유(implementation bug) 모두에 대한 검증 anchor.

---

### R3. Edit State Gate

`PreToolUse Write|Edit|MultiEdit` hook은 기존 파일 수정 직전 다음 조건을 확인한다.

**Gate 적용 대상 판정**:

* tool input에서 대상 경로를 다음과 같이 추출한다.
    * `Write`: `file_path`
    * `Edit`: `file_path`
    * `MultiEdit`: `file_path` (단일 파일 다중 edit)
* canonical key 계산:
    * 파일이 존재하면 `realpath(path)` → case-aware 정규화(R2).
    * 파일이 존재하지 않으면 다음 절차로 deep-new-path 지원:
        1. `path`의 상위 디렉토리를 차례로 거슬러 올라가며 처음 존재하는 ancestor를 찾는다.
        2. `realpath(ancestor)`를 계산하고 거기에 미존재 잔여 segment를 `path.sep`로 이어 붙인다.
        3. 결과 전체를 case-aware 정규화한다.
        4. **ancestor `realpath`가 repo_root 밖으로 이탈(symlink-out)하면 gate skip**(외부 모듈 규칙 적용).
        5. 절차 중 모든 ancestor가 부재하거나 `realpath`가 실패하면 `FILE_UNREADABLE`.
* canonical key가 repo root 외부에 위치하면 **gate skip**(deny 아님)으로 처리한다(외부 모듈 편집 등은 EGHS 범위 밖).
* canonical key가 `state_gate_paths` 매칭 규칙을 통과하고 디스크에 파일이 존재하면 gate 적용 대상이다.
* 파일이 존재하지 않으면 신규 파일 `Write` 후보다:
    1. PreToolUse는 `pre_sha: null`을 `pre/<sid>/<sha1(canonical_key)>.write.json`에 기록하고 allow한다.
    2. 결과 분류는 전적으로 R4 매트릭스에 위임한다.
    3. R4 매트릭스의 "overwrite race" 분류(에러 있음 + pre_sha=null + post_sha!=null)에서만 `OVERWRITE_RACE`로 다음 호출이 차단된다. 성공 분류(에러 없음 + pre_sha=null + post_sha!=null)는 best-effort new file success로 처리한다(§3 non-goal).

**`state_gate_paths` 매칭 문법**:

* **bash-glob 리스트 (picomatch v4 문법 — gitignore(5) 스펙이 아니다).** `**/*.ts`, `!**/*.d.ts` 형태.
* 매칭은 repo root 기준 상대 경로(`canonical_key` - `repo_root`).
* repo root는 `git rev-parse --show-toplevel` 결과. git이 아니면 hook config의 `repo_root` 또는 cwd.
* 구현은 Node `picomatch` 단일 reference, 옵션은 `{ dot: true }` 고정. config의 `matcher_engine: "picomatch"`는 이 reference 고정을 명시한다. (기존 초안의 gitignore(5) 준수 요구는 2026-07-02 spec audit에서 폐기 — picomatch에는 `gitignore` 옵션이 존재하지 않고 bash-glob 시맨틱만 제공한다.)
* gitignore와의 실측 차이 — config 작성 시 주의:
    1. `*.md`는 최상위 파일만 매칭한다. 중첩 매칭은 반드시 `**/*.md`로 쓴다.
    2. trailing `/` 디렉토리 한정(`docs/`)은 동작하지 않는다. `docs/**`로 쓴다.
    3. `!` 부정은 gitignore의 "나중 패턴이 이김" 순서 규칙이 아니라 패턴 배열의 OR 결합으로 평가된다. 순서 의존적인 부정 규칙 조합은 금지.
    4. git 출력의 비ASCII 파일명 C-quoting은 hook이 `core.quotePath=false`로 무력화한다(매칭 전제).

**Gate 조건**:

대상 파일이 `state_gate_paths`에 매칭되는 기존 파일일 때:

1. 해당 파일의 `reads/<sha1(key)>.json` state가 존재하고 `evidence ∈ {full_read, post_edit_success}`이다.
2. state의 `sid`가 현재 호출의 sid와 일치한다.
3. state의 `sha`와 현재 파일 디스크 SHA가 일치한다.
4. state의 `ts_ms`가 `stale_after_seconds`(기본 1800)를 초과하지 않는다.
5. failed marker가 없다. 두 경로 모두 확인:
   * key-scoped `failed/<sha1(key)>.json` (현 sid 또는 시스템 전체 marker).
   * sid-scoped `failed/<current_sid>/<sha1(key)>.json` (현 sid 자체 marker).
   둘 중 하나라도 존재하면 marker 해제 정책 적용; 해제 불가면 deny.

성공 시 hook은 `pre_sha = state.sha`를 `pre/<sid>/<sha1(canonical_key)>.write.json`에 기록하고 allow(`exit 0`)한다.

Deny code 전체 enum:

| Code                       | Meaning                     | Auto-unblock | Remediation                  |
| -------------------------- | --------------------------- | ------------ | ---------------------------- |
| `UNREAD_OR_STALE`          | full_read evidence 없음 또는 시간 만료 | No | 대상 파일을 다시 Read |
| `WRONG_SID`                | evidence는 있으나 다른 세션 소유 | No | 현재 세션에서 다시 Read |
| `RACE_DETECTED`            | Read 이후 디스크 SHA 변경     | No | 대상 파일을 다시 Read |
| `STATE_RECORD_FAILED`      | state 기록 실패 / stale_read   | No | 대상 파일을 다시 Read |
| `OVERWRITE_RACE`           | 신규 Write로 가정했으나 파일 존재 | No | 대상 파일을 Read 후 Edit으로 전환 |
| `SCHEMA_MISMATCH`          | schema_version 불일치 read-only 모드 | No | `eghs-migrate` 실행 |
| `SCHEMA_NOT_INITIALIZED`   | `schema_version` 파일 부재    | Yes | `eghs-init` 실행 |
| `FS_INFO_MISSING`          | case-sensitivity probe cache 부재 | Yes | `eghs-init` 실행 |
| `MIGRATE_IN_PROGRESS`      | `eghs-migrate` 실행 중       | Yes | 잠시 후 재시도 |
| `INFRA_NOT_READY`          | state dir 부재 또는 schema_version 비정상 file type, lease 기록 ENOENT/EACCES, state subdir 부재 등 인프라 결함 | No | `eghs-init` 실행 후 재시도(`--repair` 필요 시) |
| `SID_COLLISION`            | 같은 sid를 보유한 두 개의 활성 lease 감지 (anchor 불일치 + lease pid alive). Claude Code session_id 충돌 또는 구현 버그 신호. | No | hook 호출자 측 sid 발급 로직 점검; 한 세션 종료 후 재시도 |
| `FILE_UNREADABLE`          | realpath/stat 실패           | Yes (제한적) | 파일 권한/존재 확인 |
| `INPUT_PARSE`              | hook input JSON 파싱 실패     | Yes | 작업 재시도 |
| `NO_SESSION` (signal, deny 아님) | hook input에 session_id 없음 | n/a | hook은 `decision: "allow"`로 종료(gate skip)하되 debug log에 `deny_code: NO_SESSION` 기록. Edit은 차단하지 않음. enum 표기상 deny code와 함께 분류되나 실제 decision은 allow |

`Auto-unblock`이 No인 deny code는 R6 kill switch 외에는 우회 불가.

PreToolUse가 위 deny code 중 어느 하나라도 반환할 때, 본인이 작성했을 수 있는 `pre/<sid>/<key>.write.json` 임시 파일을 즉시 삭제한다(다음 호출에 stale pre_sha가 남지 않도록).

**MultiEdit 정책**:

* PreToolUse gate는 `file_path` 기준 1회 검사. SHA가 일치하면 모든 sub-edit을 통과시킨다.
* MultiEdit의 sub-edit 사이 race는 §3 Non-goal로 명시한다. Claude Code tool 구현이 sub-edit을 어떻게 적용하는지는 EGHS 보호 범위 밖.
* PostToolUse 결과는 R4 매트릭스로 처리.

---

### R4. Edit State Update

`PostToolUse Write|Edit|MultiEdit` hook은 결과를 다음 매트릭스로 처리한다.

**NO_SESSION 단락 (PreToolUse와 대칭)**:

* hook input에 `session_id`가 없으면 PostToolUse Write/Edit/MultiEdit/Read는 **즉시 short-circuit**: state write 없음, marker 기록 없음, `pre/` 조회 없음, R4 매트릭스 진입 금지. debug log에 `deny_code: NO_SESSION` + `decision: skip`만 1줄 기록 후 exit 0.
* 이 분기 적용 후에야 아래 입력/매트릭스가 적용된다.

**입력**:
* `tool_response.error`: tool 실행 에러 유무.
* `pre_file`: 1차로 `pre/<posttool_sid>/<key>.write.json` 검색.
    * 1차 hit → 정상.
    * 1차 miss → 2차 검색:
        1. `pre/` 디렉토리를 1회 enumerate해 `<sid>` 서브디렉토리 목록을 수집한다. **enumerate 시점의 wall clock을 `enum_ms`로 기록**.
        2. 각 sid에 대해 `sessions/<sid>.json` lease를 stat. lease가 부재이거나 GC 조건(R2.5)을 만족하는 dead lease이면 "dead sid" 후보로 분류. **lease가 존재하면 본문을 읽어 `renewed_ms`를 보관**.
        3. dead sid 중 `pre/<dead_sid>/<key>.write.json`이 존재하는 sid를 orphan 후보로 본다. **각 orphan 후보의 pre file `mtime_ms`(`fstat` 결과)도 함께 보관**.
        4. orphan이 1개 이상이면 unlink 직전 **TOCTOU 재검증** (normative — 단일 절차, 대안 없음):
           a. `sessions/<dead_sid>.json` lease를 re-stat.
           b. lease 부재 또는 dead(`kill(pid,0)` ESRCH) → orphan 확정.
           c. lease 존재 + pid alive → 해당 sid orphan 분류 **취소**(보수적; 살아있는 lease는 절대 침해 금지). 분류 취소된 sid의 pre file은 건드리지 않음.
           d. 확정된 orphan: **sid-scoped failed marker** `failed/<dead_sid>/<sha1(key)>.json` body=`{schema_version: 1, origin_sid: <dead_sid>, ts_ms: <enum_ms>, reason: "state_record_failed"}`로 기록(현 sid의 gate에 영향 주지 않음). `origin_sid`는 반드시 enclosing 디렉토리 sid(dead_sid)와 동일해 cascade-GC-by-sid invariant 보존. 해당 pre file unlink 후 종료. unlink는 `fstat → re-stat lease (final check) → unlinkat` 순서. final check에서 lease 부활하면 unlink 중단. **marker write는 best-effort**: tmp create/rename 중 ENOENT 발생(eghs-migrate 또는 #5b sessions GC가 `failed/<dead_sid>/` 디렉토리를 동시에 cascade-delete) 시 silently skip. dead_sid marker 손실은 현 sid gate에 영향 없으므로 INFRA_NOT_READY로 reclassify 금지.
           e. **ENOENT during enumerate/stat**: 2nd-pass 진행 중 `pre/` 또는 `sessions/`에서 ENOENT 발생 시 (eghs-migrate cascade-delete와의 race) 해당 sid는 silently skip하고 다음 후보로 계속. 모든 후보가 ENOENT로 사라졌으면 step 5로 진행.
        5. orphan이 0개면(원래 0이거나 4단계에서 모두 취소/ENOENT 됨): PreToolUse가 호출되지 않았거나 GC된 경우. **현 posttool_sid scoped failed marker** `failed/<posttool_sid>/<sha1(key)>.json` body=`{schema_version: 1, origin_sid: <posttool_sid>, ts_ms: now_ms, reason: "state_record_failed"}`로 기록 후 종료. 본 marker는 현 sid 자체의 후속 PreToolUse를 차단(올바른 root cause). 다른 sid의 gate에는 영향 없음.
    * **활성 lease 보호**: 활성 lease를 보유한 sid의 pre-file은 stat조차 하지 않는다(다른 세션의 in-flight 보호).
* `post_sha`: 현재 디스크 raw bytes의 SHA-256. 파일 없으면 `null`.

**처리 매트릭스**:

| `tool_response.error` | `pre_sha` | `post_sha` vs `pre_sha` | 분류 | 액션 |
| --- | --- | --- | --- | --- |
| 없음 | null(신규 Write 의도) | post_sha != null | new file success(best-effort) | `reads/`에 `evidence: post_edit_success` 기록 |
| 없음 | null(신규 Write 의도) | post_sha == null | unexpected | failed marker, hook은 stderr warning |
| 없음 | 있음 | 변경됨 | edit success | `reads/`에 `evidence: post_edit_success` 기록 |
| 없음 | 있음 | 동일 | no-op edit | state 유지(갱신 안 함) |
| 있음 | null | post_sha != null | overwrite race | failed marker(reason=`overwrite_race`) + `evidence: post_edit_partial` 기록 |
| 있음 | null | post_sha == null | clean failure | 변경 없음, state 유지 |
| 있음 | 있음 | 변경됨 | partial apply | failed marker(reason=`post_edit_partial`) + `evidence: post_edit_partial` 기록 |
| 있음 | 있음 | 동일 | clean failure | state 유지 |

**비고**:

* "new file success(best-effort)"는 §3 Non-goal에 명시된 대로 외부 파일 생성과 정상 성공을 구분할 수 없다(둘 다 `pre_sha=null && post_sha!=null`로 보임). v5는 후자로 가정한다. 외부 변경이었다면 다음 Edit이 stale evidence로 `RACE_DETECTED` 또는 `STATE_RECORD_FAILED`에 걸리므로 second-line 방어가 동작한다.
* `tool_response.error`가 있어도 디스크가 변경됐다면 부분 적용으로 분류해 fail-closed 한다.

**기록 방식**:

* atomic write(R2.5 절차).
* 성공 분류(`new file success`, `edit success`)에서 기존 failed marker는 R2 marker 해제 정책에 따라 제거한다.
* PostToolUse는 마지막에 `pre/<sid>/<key>.write.json`을 삭제한다(crash 시 GC가 처리).
* `post_edit_success` state의 `sid` 필드는 `posttool_sid`. 위에서 `pretool_sid == posttool_sid` 보장 후 기록하므로 G1 invariant 유지.

**신규 파일 evidence**:

* new file success로 기록된 `post_edit_success`는 R3 gate 통과 조건을 만족한다. 신규 파일을 만든 직후 즉시 추가 Edit 가능.

---

### R5. Stop-time Verification

`Stop` hook은 설정된 verification command를 실행한다.

예 (`.claude/eghs.config.json`):

```json
{
  "verification_commands": {
    "typecheck": "pnpm typecheck",
    "lint": "pnpm lint",
    "test": ""
  },
  "verification_timeout_seconds": 45,
  "verification_parallel": true,
  "verification_cwd": "<repo_root>",
  "verification_shell": ["/bin/sh", "-c"],
  "verification_env": { "EGHS_HOOK": "1", "CI": "" },
  "skip_if_only_changed": ["**/*.md", "docs/**"],
  "diff_base": "session_baseline",
  "matcher_engine": "picomatch"
}
```

**실행 환경**:

* `cwd`: `verification_cwd`(기본 repo_root). 미존재 시 cwd로 fallback.
* `env`: 부모 env 상속 + `verification_env` overlay. 값이 빈 문자열이면 unset. **단, `STOP_HOOK_ACTIVE=1`은 overlay와 무관하게 강제 주입**(recursion 보호). `verification_env`에서 `STOP_HOOK_ACTIVE`를 unset/덮어쓰기 시도 시 hook이 stderr warning 후 강제 `1`로 덮어쓴다.
* shell: `verification_shell` 배열의 첫 원소를 argv[0]으로 spawn, 두 번째부터 인자로 전달. command는 마지막 인자로 push.
* 표준 입력: `/dev/null` redirect.

**Timeout & budget**:

* 각 명령 timeout = `verification_timeout_seconds`(기본 45초).
* `verification_parallel: true`(기본)면 모든 명령을 동시 실행해 wall-time을 단일 명령 최대치로 제한.
* `verification_parallel: false`면 순차 실행. 이 경우 Stop hook의 60s 목표는 보장하지 않으며 사용자가 명령 수와 timeout을 직접 조정한다.
* timeout 초과 시 SIGTERM, 5초 후 SIGKILL. timeout은 fail로 간주.

**Skip 조건**:

* `diff_base` 옵션:
    * `"session_baseline"`(기본): `.claude/state/eghs/baselines/<sid>.txt`의 JSON body `{"commit": "...", "lease_start_ms": ..., "lease_pid": ...}`에서 `commit` 필드 사용. R6 precedence #6 anchor-bound 절차로 작성/reuse. schema 정상화 후 첫 hook 시점이 baseline의 timestamp가 된다(schema mismatch 구간에 발생한 commit은 baseline에 흡수되지 않음을 §7 risk로 명시).
    * `"head"`: 항상 현재 `HEAD`.
    * `"merge-base:<branch>"`: 지정 브랜치와의 merge-base.
* 변경 파일 목록 = `git diff --name-only <diff_base> -- .` ∪ `git ls-files --others --exclude-standard`(untracked 포함).
* `skip_if_only_changed` glob 매칭 엔진은 `matcher_engine` 설정과 동일(기본 picomatch).
* 변경 파일이 모두 `skip_if_only_changed` glob에 매칭되면 verification skip.
* git이 없거나 baseline 기록 실패 시 skip 불가, 항상 verification 실행.

**결과**:

* 하나라도 non-zero exit이면 exit 2 + **stderr**에 `[eghs] block <deny_code>: <reason>` 형식으로 실패 check 이름·exit code를 출력한다. (Claude Code Stop hook 계약: exit 2에서 stdout은 파싱되지 않고 stderr가 모델 피드백이 된다. allow는 exit 0 + 빈 stdout — `decision:"allow"` JSON은 Claude Code 출력 스키마(zod, decision enum `approve|block`)에 걸려 검증 실패한다.)
* 실패 로그는 `.claude/state/eghs/verify-logs/<sid>/<name>.log`에 저장(stdout+stderr 합쳐서). 성공 실행도 동일 경로에 저장해 metric 측정/디버깅에 활용.

**Recursion 방지**:

* `STOP_HOOK_ACTIVE=1` env 설정 시 즉시 통과.
* `locks/stop-<sid>.lock`을 R2.5 절차로 획득. stale lock 회수 정책 적용.
* lock 획득 실패(다른 활성 hook 또는 회수 불가) 시 **block** 반환(fail-closed). G3 보장.

**Performance budget**:

* Stop hook wall-time 목표: median ≤ 60s, p95 ≤ 90s(parallel mode, 위 timeout 기준).
* PreToolUse/PostToolUse hook 각 100ms p95(SHA 계산 포함). 큰 파일(>`max_full_read_bytes`)은 partial로 처리해 budget 유지.

---

### R6. Escape / Kill Switch

False-positive escape는 **인프라성 오류**에만 적용한다.

Auto-unblock 허용(R3 enum의 `Auto-unblock: Yes`):

* `INPUT_PARSE`
* `NO_SESSION`
* `SCHEMA_NOT_INITIALIZED`
* `FS_INFO_MISSING`
* `MIGRATE_IN_PROGRESS`
* 일부 `FILE_UNREADABLE`(권한 거부 등 사용자가 즉시 인지 가능한 경우)

Auto-unblock 금지(R3 enum의 `Auto-unblock: No`):

* `UNREAD_OR_STALE`
* `WRONG_SID`
* `RACE_DETECTED`
* `STATE_RECORD_FAILED`
* `OVERWRITE_RACE`
* `SCHEMA_MISMATCH`
* `INFRA_NOT_READY`
* `SID_COLLISION`
* Stop verification failure

즉, evidence 부족이나 SHA mismatch는 자동으로 우회하지 않는다.

**평가 순서 (precedence)**:

각 hook 진입 직후 다음 순서로 평가한다. 먼저 매칭되는 조건이 이긴다. **Hook 종류별 분기 포함**.

**중요한 invariant**: precedence #1~#3은 **state mutation 절대 금지**(stat/env 검사만). state mutation은 #4 이후에만 발생. kill switch/CI passthrough가 set이면 mutation 절차에 진입조차 안 한다. 이는 G5 ("즉시 비활성화 가능") + §R6 "kill switch 환경에서 disk leak 없음" 보장의 단일 근거.

1. **on-disk schema_version 읽기 (stat-only, mutation 없음)**: `.claude/state/eghs/schema_version`을 stat. mkdir/생성하지 않음.
    * 파일 부재 또는 state dir `ENOENT` → `disk_schema = null` (NOT_INITIALIZED 신호).
    * regular file이 아닌 비정상(디렉토리/symlink 끊김/소켓/FIFO 등) → `disk_schema = INVALID`.
    * regular file이지만 size > 32 bytes → `disk_schema = INVALID`(읽지 않음).
    * regular file이고 size ≤ 32 bytes → 읽어서 **strict 검증**: 정확히 정규식 `^[1-9][0-9]*\n$` 매칭이어야 한다(BOM 금지, 선행 0 금지, 선행/후행 공백 금지, 추가 개행 금지, NUL 금지). 모든 위반 → `disk_schema = INVALID`. 매칭 성공 시 정수 부분만 파싱해 `disk_schema = <int>`.
    * `disk_schema == INVALID`는 NOT_INITIALIZED와 **명확히 구분**(아래 #7 분류 참조). INVALID은 fail-OPEN을 절대 허용하지 않는다.
2. **Kill switch** (stat/env 검사만, mutation 없음): `.claude/eghs-off` regular file 또는 `EGHS_DISABLED=1`이면 즉시 exit 0. 모델 우회 risk는 §3 non-goal로 명시. stderr에 `[eghs] kill-switch active: <reason>` 1줄 로그 외 어떤 disk write도 없음.
3. **CI passthrough** (env 검사만, mutation 없음): Stop hook을 제외한 hook에서만 적용. `CI=true/1`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `BUILDKITE=true` 중 매칭 시 exit 0. Stop은 G3 보장을 위해 CI에서도 verification을 강제하므로 본 단계를 건너뛴다.
4. **migrate.lock 체크 (state mutation 가능: stale lock 삭제)**: `.claude/state/eghs/migrate.lock` stat 후 다음 분기. 본 단계가 반환하는 모든 deny code는 **hook 종류별 재분류 매트릭스**(아래 표)를 통과한 결과를 반환한다.
    * 부재 → 다음 단계.
    * regular file이고 lock content 파싱 실패(open ENOENT race, JSON 깨짐 등) → 본 결정 보류, retry 1회 후 여전히 실패면 hook-type 매트릭스로 `INFRA_NOT_READY` 반환.
    * regular file이고 lock content의 `uid` == 현재 hook uid이며 `kill(pid,0)` 성공 → 후보 `MIGRATE_IN_PROGRESS`.
    * regular file이고 same uid이지만 `kill(pid,0)` EPERM(PID namespace/sandbox 등 비정상) → 후보 `MIGRATE_IN_PROGRESS`(liveness 판정 불가, fail-closed).
    * regular file이지만 `uid` != 현재 hook uid:
        * lock의 `start_ms + foreign_migrate_lock_grace_ms`(기본 7200s = 2h) 미경과면 후보 `MIGRATE_IN_PROGRESS`(다른 사용자 migrate 진행 가정).
        * grace 경과면 foreign-stale 추정 → 후보 `INFRA_NOT_READY`. stderr에 `eghs-migrate --force-foreign-cleanup` 실행 안내. 자동 삭제는 권한 risk로 인해 수행하지 않음.
    * regular file이고 same uid + `kill(pid,0)` ESRCH(dead) + `start_ms + migrate_lock_grace_ms`(기본 600s) 경과 → stale 판정, 삭제 후 다음 단계.
    * regular file이지만 same uid + dead + grace 미경과 → 후보 `MIGRATE_IN_PROGRESS`(짧은 crash 직후 보호 기간).
    * regular file이 아닌 비정상 type → 후보 `INFRA_NOT_READY`(인프라 결함). `FILE_UNREADABLE` 아님(자동 우회 금지).

    **Hook-type 재분류 매트릭스**(후보 → 실제 반환): G3/R1 보장을 위해 hook별로 결과를 다르게 분류한다.

    | Hook | 후보 `MIGRATE_IN_PROGRESS` | 후보 `INFRA_NOT_READY` | 후보 `SID_COLLISION` |
    | --- | --- | --- | --- |
    | `UserPromptSubmit` | stderr warning + additionalContext "migrate in progress" 1줄 + **normal exit 0** (R1 fail-soft, 사용자 입력 차단 금지) | 동일하게 fail-soft normal exit | 동일하게 fail-soft normal exit + additionalContext "sid collision detected, check Claude Code sid uniqueness" |
    | `Stop` | **block, auto-unblock=No** (G3: verification 실행 안 했으므로 자동 통과 금지). deny_code는 `INFRA_NOT_READY` (auto-unblock=No)로 마스킹해 반환. 원본 후보는 debug log에만 기록. | block, auto-unblock=No | block `SID_COLLISION`, auto-unblock=No |
    | `PostToolUse Write/Edit/MultiEdit` | **fail-closed marker 기록 후 exit 0**: 현재 sid의 sid-scoped marker `failed/<sid>/<sha1(key)>.json`을 `reason=migrate_in_progress`로 atomic 작성(가능하면; state dir write 권한 없으면 best-effort), `pre/<sid>/<key>.write.json`은 unlink. 후속 PreToolUse가 `STATE_RECORD_FAILED`로 정확한 root cause 차단. | 동일 처리(`reason=infra_not_ready`). | 동일 처리(`reason=sid_collision`). |
    | `PostToolUse Read` | state write skip, exit 0 (read-only fallback). | 동일. | 동일. |
    | `PreToolUse Write/Edit/MultiEdit` | block `MIGRATE_IN_PROGRESS` (auto-unblock=Yes). 본인이 만든 pre file 즉시 unlink. | block `INFRA_NOT_READY` (auto-unblock=No). | block `SID_COLLISION` (auto-unblock=No). pre file 즉시 unlink. |
    | `PreToolUse Read` | block `MIGRATE_IN_PROGRESS` (auto-unblock=Yes). pre file unlink. | block `INFRA_NOT_READY` (auto-unblock=No). | block `SID_COLLISION` (auto-unblock=No). pre file unlink. |

    위 매트릭스는 동일하게 precedence **#6 lease 작성 실패(EEXIST 제외)** 시에도 적용된다(중복 명세 제거를 위해 본 표를 참조).
5. **recover.lock GC + sessions/ GC + state subdir 검증** (state mutation): kill switch와 CI passthrough를 통과한 후에만 진입.
    a. **recover.lock GC**: state dir 존재 시 `locks/` 디렉토리를 1회 scan해 자기 uid 소유의 stale recover.lock(`kill(pid,0)` ESRCH + `start_ms + recovery_grace_ms` 경과)을 best-effort unlink. foreign-uid는 건드리지 않음.
    b. **sessions/ GC** (R2.5 정책): `sessions/<sid>.json` 중 (renewed_ms stale + same uid + pid dead) 조건 만족하는 lease를 unlink. 각 GC sid에 대해 cascade delete(baselines/<sid>.txt + verify-logs/<sid>/ + debug/<sid>.jsonl + pre/<sid>/ + failed/<sid>/). best-effort, ENOENT/EPERM 둘 다 silently skip(orphan은 다음 GC pass에서 표면화).
    c. **state subdir 검증**: subdir(`tmp/`, reads/, reads/tmp/, failed/, failed/tmp/, pre/, locks/, locks/tmp/, sessions/, sessions/tmp/, baselines/, baselines/tmp/, verify-logs/, debug/) 중 하나라도 부재면 다음 분기:
       * **`disk_schema == null` (state dir 자체 부재 또는 schema_version 부재)**: clean-install 시나리오로 판정 → 본 단계 검사 skip, #7 `NOT_INITIALIZED` 분기로 위임(`eghs-init` 실행 안내). subdir-only-missing과 분리 처리해 부트스트랩 봉쇄 방지.
       * **`disk_schema == hook_version` (정상 schema + subdir만 일부 부재)**: 부분 초기화/수동 삭제 회복 시나리오 → **`INFRA_NOT_READY`** 후보로 #4 매트릭스 적용. remediation은 `eghs-init --repair` (아래 §R2.5 eghs-init --repair 정의 참조).
       * **그 외(INVALID/MISMATCH + subdir 부재)**: `INFRA_NOT_READY` 후보로 #4 매트릭스. 본 단계에서 디렉토리 절대 생성 금지. eghs-init이 단일 부트스트랩 책임.
6. **세션 lease 기록** (state mutation): #4/#5 통과 후 다음 절차.
    1. `migrate.lock`을 stat-only로 재확인. 존재하면(precedence #4 시점 이후 새로 생긴 경우) `MIGRATE_IN_PROGRESS` 후보 → #4 매트릭스 적용.
    2. `schema_version` 파일을 재읽기해 `disk_schema_now` 획득. `disk_schema_now != disk_schema`이면 `MIGRATE_IN_PROGRESS` 후보 → #4 매트릭스 적용(이는 migrate가 #1과 #6 사이에 완주한 race).
    3. `disk_schema_now`가 hook 코드 버전과 **일치**하고 정상 case일 때만 lease/baseline 작성:
        * `sessions/<sid>.json` create/renew 분기 (normative semantics):
            - **stat 결과 부재** → R2.5 atomic write 절차(sessions/tmp/ 사용)로 create. body: `{schema_version, pid: current claude-code-pid, uid, start_ms: now_ms, renewed_ms: now_ms}`. R2.5 절차는 rename(2) 사용 — race로 EEXIST 발생 시(다른 hook이 동시 create) 다음 stat 결과를 그대로 사용해 renew 분기로 진입.
            - **stat 존재 + body.pid == current_pid** → **renew**: 본문 read → `renewed_ms` 갱신만 → R2.5 atomic write로 overwrite. `start_ms`는 절대 변경 금지.
            - **stat 존재 + body.pid != current_pid** → **lease body 절대 overwrite 금지**. body를 그대로 보존하고 6.3b 분기로 진입(아래 anchor 검증에서 적절한 분류).
        * `baselines/<sid>.txt` 작성 — **anchor-bound + link(2) exclusive** 절차:
            a. 존재하지 않으면 **link(2) 기반 exclusive create**(R2.5의 `locks/stop-<sid>.lock` 동일 패턴): `baselines/tmp/<sid>.<pid>.<seq>`에 본문 작성 + fsync → `link(2)`로 최종 경로로 이동(EEXIST 시 다른 hook이 선점, 3b 분기로 진입). rename(2)은 사용 금지(overwrite 허용으로 anchor guard 무력화됨). 본문 = JSON `{"commit": "<rev-parse HEAD or NO_GIT>", "lease_start_ms": <sessions/<sid>.json.start_ms>, "lease_pid": <sessions/<sid>.json.pid>}`. **lease_pid는 baseline 작성자가 직접 보는 PID가 아니라 sessions/<sid>.json body의 pid 필드 값을 그대로 복사**(앵커 일관성 보장).
            b. 존재하면 본문을 읽어 anchor 검증 후 **단일 결정 트리** (b와 c는 mutually exclusive, 아래 순서대로 평가 — 먼저 매칭되는 분기가 이김):
               1. **anchor 일치 AND sessions.pid == current claude-code-pid** (anchor `lease_start_ms == sessions.start_ms` AND `lease_pid == sessions.pid` AND `sessions.pid == current_pid`) → **reuse OK**, 정상 종료. pid 동일성 검사는 foreign-pid가 살아있고 anchor도 우연 일치하는 SID_COLLISION 미감지 방지(G1 보호).
               2. **anchor 일치 AND sessions.pid != current_pid AND sessions.pid alive** (`kill(sessions.pid, 0)` 성공 or **same-uid EPERM**(PID namespace/sandbox 비정상)) → **6.3c SID_COLLISION 분기**. fail-closed.
               3. **anchor 불일치 AND sessions.pid alive** (`kill(sessions.pid, 0)` 성공 or same-uid EPERM) → **6.3c SID_COLLISION 분기**. 본 stale-cleanup 절대 실행 금지(살아있는 lease 침해 금지).
               4. **sessions/<sid>.json 부재** OR **anchor 불일치 AND lease pid dead(ESRCH)** OR **anchor 일치 AND lease pid dead(ESRCH)** OR **baseline JSON parse 실패** → **stale-cleanup 분기**(절차 i–iv):
                  i. `sessions/<sid>.json` 잔존 시 read하여 기존 `start_ms`(`prior_start_ms`)와 기존 본문 전체를 임시 보존. 그 후 unlink(stale lease가 renew로 ressuscitate되지 않게).
                  ii. baselines/<sid>.txt + verify-logs/<sid>/ + debug/<sid>.jsonl + pre/<sid>/ unlink + failed/<sid>/ unlink + **failed/<sha1(*)>.json key-scoped marker 중 origin_sid == `<현 cleanup 대상 sid (파일명)>`인 것 unlink** (전체 `failed/` 디렉토리 scan; expensive하지만 race 안전 위해 필수). 모두 best-effort. **ii의 결과 분기**:
                     * 모두 성공 또는 ENOENT만 발생 → step iii에서 `prior_start_ms` 보존 가능.
                     * EPERM 등 진짜 실패가 1건이라도 발생 → key-scoped foreign marker가 잔존 가능성 있음. step iii에서 `prior_start_ms` 사용 금지, **`now_ms` fallback** 사용. 이로써 잔존 marker `ts_ms < now_ms` 만족 → R2 self-clear 정책 발동 가능, deadlock 방지.
                  iii. lease 재작성: sessions/<sid>.json `O_CREAT|O_EXCL` create with `{pid: current claude-code-pid, uid, start_ms: <ii 분기 결정>, renewed_ms: now_ms}`. EEXIST면 다른 hook이 동시 재생성 → 그 lease body의 pid를 stat → current_pid와 일치하면 renew 분기, 다른 pid alive(or same-uid EPERM)면 SID_COLLISION, 다른 pid dead면 본 b 재진입(1회 retry, 그래도 실패 시 후보 `INFRA_NOT_READY` → #4 매트릭스).
                  iv. #6.3a baseline 작성(link(2) exclusive) 1회 재시도. 실패 시 후보 `INFRA_NOT_READY` → #4 매트릭스.
            c. **SID_COLLISION 분기** (b의 결정 트리에서만 도달): 후보 `SID_COLLISION` → #4 hook-type 매트릭스의 SID_COLLISION 컬럼 적용. sessions/<sid>.json 절대 unlink 금지. 디버그 로그에 collision detail(현 pid, foreign pid, start_ms들) 기록.
    4. `disk_schema_now`가 `null` / `INVALID` / mismatch이면 lease 기록 skip하고 다음 단계로 진행(다음 단계에서 hook 종류별로 분기).
    5. lease/baseline 작성 실패 처리:
        * `EEXIST`(이미 존재) + anchor OK → 정상 reuse.
        * `EEXIST` + anchor 불일치 → 위 3b/3c 절차 적용.
        * `ENOENT`/`EACCES` 등 진짜 오류 → 후보 `INFRA_NOT_READY`로 #4 단계의 **Hook-type 재분류 매트릭스**를 그대로 적용한다. 단, `PostToolUse Write/Edit/MultiEdit`의 marker `reason`은 `lease_unavailable`로 표기(원래 root cause 보존).
7. **schema_version / fs-info.json** 체크: `disk_schema_now` 상태와 `fs-info.json` 존재 여부로 분류한 후 hook 종류별로 분기.

   **상태 분류**:
   * `disk_schema_now == null` (state dir 또는 schema_version 파일 부재) → **NOT_INITIALIZED**.
   * `disk_schema_now == INVALID` (비정상 file type, size 초과, strict regex 위반 — #1 참조) → **INVALID** (fail-closed for ALL hooks except UserPromptSubmit R1 fail-soft).
   * `disk_schema_now != hook_version` (mismatch) → **MISMATCH**.
   * `disk_schema_now == hook_version`이지만 `fs-info.json` 부재 → **FS_INFO_MISSING**.
   * 모두 정상 → 8단계로 진행.

   **Hook별 분기**:
   * `UserPromptSubmit`: NOT_INITIALIZED/MISMATCH/FS_INFO_MISSING/INVALID **모두 fail-soft** (R1). stderr warning + `additionalContext`에 1줄 안내("run `eghs-init`" 또는 "run `eghs-migrate`") 후 normal exit. 본래 prompt discipline 메시지는 skip.
   * `Stop`:
       * MISMATCH/FS_INFO_MISSING: state dir과 `locks/`는 이미 존재한다(state dir 자체는 있고 schema만 어긋난 상태). 평소대로 lock 획득 후 verification 실행(state-read 의존 없음).
       * NOT_INITIALIZED / INVALID: state dir 부재 또는 schema 깨짐. **fail-closed `INFRA_NOT_READY`**(infrastructure, auto-unblock=No for Stop)로 block, remediation은 `eghs-init` 또는 `eghs-init --repair` 실행. Stop을 무조건 통과시키면 G3 위반이므로 fail-closed가 정답.
       * 어떤 분기에서도 fallback Stop은 `mkdir -p`로 state dir을 생성하지 않는다(`eghs-init`이 명시적 부트스트랩).
   * `PostToolUse Write/Edit/MultiEdit`:
       * NOT_INITIALIZED/MISMATCH/FS_INFO_MISSING: state write skip하고 exit 0 (fail-soft. 이 경로에서는 후속 PreToolUse가 동일 상태로 차단되므로 second-line 방어가 동작).
       * **INVALID**: state write skip + **sid-scoped failed marker** `failed/<sid>/<sha1(key)>.json` (reason=`schema_invalid`) 기록 (R4 매트릭스와 일관, INVALID never fail-OPEN 원칙 적용). marker write 자체가 ENOENT/EPERM이면 best-effort skip. `pre/<sid>/<key>.write.json`도 unlink. INVALID 해소(`eghs-init --repair`) 후 첫 PreToolUse가 `STATE_RECORD_FAILED`로 정확한 root cause 차단.
   * `PostToolUse Read`: 모든 상태에서 state write skip하고 exit 0(읽기 전용, fail-soft).
   * `PreToolUse Write/Edit/MultiEdit`: 상태별 deny code 반환.
       * NOT_INITIALIZED → `SCHEMA_NOT_INITIALIZED`(auto-unblock=Yes).
       * MISMATCH → `SCHEMA_MISMATCH`(auto-unblock=No).
       * FS_INFO_MISSING → `FS_INFO_MISSING`(auto-unblock=Yes).
       * INVALID → `INFRA_NOT_READY`(auto-unblock=No).
8. 정상 hook logic.

**Kill switch**:

* `.claude/eghs-off` (regular file 또는 symlink 대상이 regular file; 디렉토리/소켓 등 다른 type은 무시) 존재 시 모든 hook exit 0.
* `EGHS_DISABLED=1`이면 모든 hook exit 0.

**CI passthrough (Stop hook 제외)**:

* `CI=true/1`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `BUILDKITE=true` 환경에서 `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PostToolUse Read` hook은 graceful pass(exit 0).
* **Stop hook은 CI passthrough에서 제외한다.** CI 환경에서 자율적으로 실행되는 Claude Code 세션이야말로 typecheck/lint를 보장해야 하므로 G3 보장이 더 중요하다. CI에서 Stop verification을 끄려면 명시적으로 `EGHS_DISABLED=1` 또는 `.claude/eghs-off`를 사용한다.

**로그**:

* Kill switch/CI passthrough 발동 시 stderr에 `[eghs] kill-switch active: <reason>` 1줄 로그만 출력한다. debug log(`<sid>.jsonl`) 등 state dir 쓰기는 수행하지 않는다(precedence #3/#4는 sessions lease보다 앞이므로 state 쓰기 없음 원칙 유지).
* state-leak이 허용된 환경(즉, kill switch가 꺼졌고 schema 정합성 OK)에서 debug log를 한꺼번에 기록한다.

**Kill switch threat model**:

* §3 Non-goal로 명시된 대로, 모델 자신이 Bash로 env를 세팅하거나 파일을 생성해 우회하는 시나리오는 방어 대상이 아니다.
* 운영자가 모델 우회를 줄이려면:
    1. system prompt에 kill switch 사용 금지를 명시한다.
    2. `.claude/eghs-off`와 `.claude/eghs.config.json`의 쓰기 권한을 사용자 전용으로 제한(`chmod 600`/디렉토리 `chmod 700`).
    3. `EGHS_DISABLED` 같은 env 이름을 운영자만 알도록 config의 `kill_switch_env`로 재명명한다.

---

## 5. Success Metrics

| Metric                      | Definition                                                                                        | Target | MVP measurable? |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------ | --------------- |
| Evidence-bearing Edit ratio | 세션당 `(PreToolUse Write/Edit/MultiEdit decision=allow with has_gate_passing_state=true) / (전체 PreToolUse Write/Edit/MultiEdit gate_applicable=true)` | > 0.9 (예상) | Yes |
| Gate deny ratio             | 세션당 `(decision=block on gate_applicable=true) / (전체 gate_applicable=true PreToolUse)` | tracked, < 0.2 권장 | Yes |
| Bash-bypass detection rate  | Bash로 파일이 변경된 직후 같은 파일의 Edit 호출이 `RACE_DETECTED`로 deny된 비율(Bash 변경 detect는 polling SHA diff로 측정)         | > 90%  | Yes (best-effort) |
| False-deny rate             | 사람이 잘못된 deny로 라벨링한 비율                                                                  | < 5%   | No (post-MVP `eghs-label` 도입 후) |
| Stop verification pass rate | self-correction 포함 최종 Stop 통과 비율 (kill_switch 이벤트 제외)                                  | > 95%  | Yes |
| Stop latency p50/p95        | Stop hook wall time                                                                            | p50 < 60s, p95 < 90s | Yes |
| Kill switch usage           | 주당 kill switch 발동 횟수                                                                              | < 1회   | Yes |

`Gate enforcement rate`는 hook 코드 자체의 invariant(allow ⇒ evidence 있음)이므로 unit test로 보장하며, runtime metric에서는 제거.

**측정 방법**:

* 모든 hook은 `.claude/state/eghs/debug/<sid>.jsonl`에 1줄 1이벤트 JSON 로그를 남긴다. **MVP에서는 metric 측정을 위해 default ON**(`debug: false` config로만 끌 수 있음).
* 이벤트 schema:

```json
{
  "schema_version": 1,
  "ts_ms": 1780000000000,
  "sid": "<session-id>",
  "hook": "PreToolUse|PostToolUse|UserPromptSubmit|Stop",
  "tool": "Read|Write|Edit|MultiEdit|Grep|Glob|...",
  "path": "<canonical-key>|null",
  "gate_applicable": true,
  "has_gate_passing_state": false,
  "evidence_kind": "full_read|post_edit_success|null",
  "kill_switch": "off|file|env|ci",
  "decision": "allow|block|skip|kill_switch",
  "deny_code": "UNREAD_OR_STALE|...|null",
  "latency_ms": 12
}
```

* `has_gate_passing_state`는 R3 gate 통과 조건을 만족하는 evidence(`full_read` 또는 `post_edit_success`) 보유 여부. `evidence_kind`는 구체적 종류(metric 세분화용).
* `Evidence-bearing Edit ratio`/`Gate deny ratio`는 위 schema의 필드만으로 계산 가능.
* `Bash-bypass detection rate`: 일정 주기로 watched paths의 SHA를 polling해 변경을 감지한 직후의 Edit gate 결과를 측정. polling은 별도 background script(`eghs-bypass-watcher`)로 옵션 제공.
* `Stop verification pass rate` = `count(Stop, decision=allow, kill_switch=off) / count(Stop, kill_switch=off)`.
* False-deny rate는 `eghs-label` CLI(post-MVP)로 사람이 deny 이벤트에 `false_positive: bool` annotation을 추가. **MVP에서는 not-measured로 명시**.

---

## 6. Rollout Plan

| Phase | Enabled Hooks            | Scope               | Exit Criteria                  |
| ----- | ------------------------ | ------------------- | ------------------------------ |
| P1    | Stop hook                | typecheck/lint only | Stop block 후 self-correct 가능   |
| P2    | + UserPromptSubmit       | prompt discipline   | 모델이 Read/verify 흐름을 따르는지 정성 확인 |
| P3    | + Read/Edit state writer | gate off, state 기록만 | state 생성/갱신 정상                 |
| P4    | + state-gate             | 핵심 source path만     | evidence-bearing Edit ratio > 0.9, 인지된 false-deny 0건 |
| P5    | matcher 확장               | source/config 전체    | Bash-bypass detection > 90%, kill switch < 주 1회  |

**P3 검증 도구**: `eghs-inspect` CLI(또는 `node hooks/inspect.js`)로 현재 state dir 내용을 dump하고 dry-run hook input을 stdin으로 받아 결정을 출력한다(MVP item 7).

---

## 7. Risks

| Risk                                | Mitigation                                          |
| ----------------------------------- | --------------------------------------------------- |
| Grep/Glob만으로 evidence가 충분하다고 오판     | `full_read`/`post_edit_success`만 gate 통과            |
| Bash로 파일 변경 시 gate 우회               | non-goal 명시, 후속 Edit에서 `RACE_DETECTED`로 탐지        |
| Read tool ↔ PostToolUse SHA TOCTOU  | PreToolUse Read SHA 비교 시 `stale_read` 분류, 비교 불가 시 v5 허용 risk |
| MultiEdit sub-edit 사이 race          | non-goal 명시, R4 부분 실패 매트릭스로 fail-closed         |
| 기존 코드베이스의 pre-existing typecheck 실패 | changed-scope verification 권장, 초기에는 test opt-in     |
| Stop hook 무한 루프                     | `STOP_HOOK_ACTIVE` env + sid-scoped lock           |
| stale lock으로 verification 무력화       | pid liveness + TTL 회수, 실패 시 fail-closed         |
| false-positive로 작업 흐름 차단            | 인프라성 deny code에 한해 제한적 escape                       |
| state 위조                            | v5 비보장, trust boundary는 local filesystem permission |
| repo script RCE                     | v5 비보장, CODEOWNERS/리뷰 프로세스가 방어선                     |
| 모델이 kill switch 우회                  | v5 비보장, 운영 가이드(§R6)로 완화                             |
| 동시 세션 state race                    | atomic write(fsync 포함) + sid-scoped pre/locks      |
| 동시 세션 schema upgrade                | schema mismatch 시 read-only fallback, 수동 `eghs-migrate` |
| 큰 파일 hook latency                   | `max_full_read_bytes`로 partial 처리, gate 통과 안 시킴   |
| Caseless FS path 충돌                 | `eghs-init`이 1회 probe, `fs-info.json`에 캐시           |
| Out-of-repo path 편집                 | gate skip(non-applicable), 책임은 사용자                |
| Schema-mismatch 구간 commit이 session_baseline에 흡수 안 됨 | baseline은 schema healthy 첫 hook 시점에 기록되므로 mismatch 구간에 만든 commit은 diff_base 외부로 분류됨. 사용자가 `eghs-migrate` 후 baseline reset을 원하면 baselines/<sid>.txt 수동 삭제 권장 |
| PreToolUse → tool exec 외부 변경       | non-goal, 후속 Edit의 SHA 비교로 second-line 탐지       |
| 신규 파일 OVERWRITE_RACE false-negative | non-goal(best-effort), Claude Code no-clobber Write 운영 권장 |
| 시간 truncation false-positive `full_read` | non-goal, 후속 버전에서 Claude Code truncation flag 도입 검토 |
| `kill -0` ESRCH/EPERM 혼동           | lock에 uid 기록, 다른 uid 잠금은 stale 판정 금지            |
| CI에서 Stop verification 우회 risk     | CI passthrough는 non-Stop hook에만 적용, Stop은 명시적 kill switch 요구 |
| 동시 세션이 같은 file 동시 Edit             | atomic write로 marker corruption 없음, 그러나 마지막 writer 우선 |

---

## 8. MVP Definition

v5 MVP는 다음을 만족하면 완료로 본다.

1. 기존 파일을 Read 없이 Edit하면 `UNREAD_OR_STALE`로 deny된다.
2. Read 이후 파일 SHA가 바뀌면 `RACE_DETECTED`로 deny된다.
3. Read → Edit 성공 후 새 SHA가 `evidence: post_edit_success`로 기록된다.
4. Grep/Glob만으로는 기본 Edit이 허용되지 않는다.
5. Stop 시 typecheck/lint 실패가 있으면 block된다. stale lock은 자동 회수 또는 fail-closed로 verification을 우회하지 않는다.
6. kill switch와 CI passthrough가 동작한다.
7. 모든 hook은 stdin JSON 기반 dry-run 테스트가 가능하다.
    * Interface: `<hook-script> --dry-run < input.json`.
    * exit code enum: `0` = allow/skip/kill_switch, `2` = block(Claude Code spec), 기타 코드는 hook 자체 crash로 간주.
    * Stop hook stdout: allow 시 빈 출력(Claude Code 스키마상 `decision:"allow"` JSON은 무효). UserPromptSubmit stdout: `hookSpecificOutput` envelope만.
    * stderr: block 시 `[eghs] block <deny_code>: <reason>` + check별 상세 라인(exit 2에서 Claude Code가 모델에 전달하는 유일한 채널), 그 외 자유 형식 디버그 메시지. 구조화 결정 기록은 `debug/` 로그가 담당.
8. shellcheck 통과(Bash 구현 시) 또는 `tsc --noEmit` + `eslint` 통과(Node 구현 시). 구현 언어는 config 외 hook 코드 단위로 통일.
9. `state_gate_paths`는 bash-glob(picomatch v4, `{ dot: true }`)으로 명세된다. gitignore(5) 시맨틱이 아니다 — 중첩 매칭은 `**/` 접두 필수, trailing `/` 디렉토리 한정 미지원 (§R4 매칭 문법 참조).
10. canonical path는 case-aware `realpath`(R2 참조), SHA는 디스크 raw bytes의 SHA-256으로 통일된다. case-sensitivity는 `eghs-init`이 1회 probe해 `fs-info.json`에 캐시한다.
11. atomic state write는 **destination-local** `tmp/` 임시 파일 + `fsync(fd)` + same-dir `rename(2)` + `fsync(dirfd)` 절차를 따르며, 임시 파일명 suffix는 per-write 단조 카운터.
12. cross-session 정책: `reads/` 공유, gate는 `sid` 일치 요구.
13. `pre/<sid>/`, `failed/`, `locks/`, `verify-logs/`, `reads/`, `reads/tmp/`, `failed/tmp/`, `sessions/`, `baselines/` 디렉토리의 GC/lifecycle 정책이 구현된다. `reads/`는 TTL + sid liveness 기반 GC, `sessions/`는 TTL + pid/uid liveness 기반 GC.
14. `eghs-init` CLI가 부트스트랩(schema_version 파일, fs-info.json 생성)을 수행하고, `eghs-migrate` CLI가 schema upgrade를 처리한다(자동 삭제 금지). `eghs-migrate`는 `sessions/` 및 `locks/`가 비어 있을 때만 동작한다.
15. Stop hook의 `verification_parallel` 기본값은 true이며, 단일 명령 timeout 기본값 45초로 p95 90s budget을 충족한다.
16. Kill switch는 SCHEMA_MISMATCH보다 우선 평가되고, CI passthrough는 Stop hook을 제외한 hook에만 적용된다.
17. PostToolUse가 `pre/<posttool_sid>/<key>.write.json`을 로드하지 못하면 `STATE_RECORD_FAILED` failed marker를 남긴다. `pretool_sid == posttool_sid` invariant가 깨지면 동일 처리.
18. failed marker는 `origin_sid` + `ts_ms`로 tagged되며, 다른 세션의 marker는 현 세션 `sessions/<sid>.json`의 immutable `start_ms` 이전이어야 자동 해제된다. key-scoped와 sid-scoped marker 두 가지 경로를 모두 처리하며 sid-scoped는 cascade GC된다.
