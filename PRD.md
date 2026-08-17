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
* 파일시스템 case-sensitivity 감지: 결과는 `.claude/state/eghs/fs-info.json`에 1회만 캐시한다(아래 절차). hook은 매 호출마다 cache 파일을 `stat + read`한다(§R6 #3.3 flock_ok/FS anchor 검증 참조; 쓰기는 없음). caseless FS(macOS APFS 기본, Windows NTFS 등)면 canonical key는 `lowercase(NFC(realpath))` — Unicode NFC 정규화를 먼저 적용해 같은 파일의 NFD/NFC 표기(한글 자소분리, `café` 등)가 다른 key로 갈라지는 것을 막는다(2026-07-03 P3 finale 개정). 그 외는 `realpath` 그대로 사용한다.
* cache 초기화 절차(installer/first-run helper가 수행, hook 내에서는 trigger만) — **canonical lock 순서**: `migrate.lock` → `.init.lock` (init/migrate mutex 규칙과 일치, 자세한 절차는 R2.5 `eghs-init` 참조):
    1. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득(role: "init"). init/migrate 간 mutex 단일 진실. 획득 실패 시 stale 회수 규칙(precedence #4)을 적용하고 안 되면 종료.
    2. 역할 검증 후 `.claude/state/eghs/.init.lock`을 `O_CREAT|O_EXCL`로 획득(내부 단계 보호).
    3. `fs-info.json` 부재 시 `.cs-probe`/`.CS-PROBE` 파일을 atomic create 후 동일 inode 여부로 caseless 판정.
    4. 결과를 `{ "schema_version": 1, "caseless_fs": bool, "ts_ms": ..., "flock_ok": true, "fs_st_dev": <state root의 st_dev>, "fs_statfs_id": "<platform>:<value>" }`로 atomic write (R2.5 eghs-init step 6 flock probe 완료 후 최종 형태; 상세는 §R2.5 참조).
    5. probe 파일 → `.init.lock` → `migrate.lock` 순서로 삭제. **모든 early-exit path(에러/시그널/재시도)에서 획득한 lock들을 역순으로 반드시 release**(`.init.lock`이 활성 `migrate.lock` 없이 잔존하는 상태 금지).
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
* PreToolUse Read hook도 SHA를 계산해 `pre/<sid>/<sha1(key)>.<tool_use_id>.read.json`에 임시 기록한다. PostToolUse Read는 이 값을 로드해 PostToolUse SHA와 비교한다.
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
  "reason": "stale_read|state_record_failed|post_edit_partial|overwrite_race|migrate_in_progress|infra_not_ready|sid_collision|lease_unavailable|schema_invalid|sid_cleared|migrate_lock_corrupt"
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
│   └── <sid>/<sha1(canonical_key)>.<tool_use_id>.{write|read}.json   # R3/R2 PreToolUse 임시 (tool_use_id per-file 접미어 — 병렬 Read/Edit race 차단)
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
    * PreToolUse Write/Edit/MultiEdit은 `<sha1(key)>.<tool_use_id>.write.json`에 대상 파일 직전 SHA(`pre_sha`)와 PreToolUse sid(`pretool_sid`)를 기록한다.
    * PreToolUse Read는 `<sha1(key)>.<tool_use_id>.read.json`에 PreToolUse 시점 SHA를 기록한다.
    * `tool_use_id` per-file 접미어로 **동일 sid의 병렬 Read/Edit이 pre-record를 공유하지 않게** 한다(G2 보호: 병렬 Read A→B→PostReadA_deleteRecord→ReadB fallback으로 stale SHA를 `full_read`로 기록하는 race 차단). Claude Code가 tool call마다 발급하는 고유 ID를 사용.
    * lifecycle: PostToolUse가 동일 sid+path+tool_use_id의 pre file을 로드해 결정 후 삭제한다.
    * **정상 상태의 pre-record 부재는 gate 통과 evidence로 사용 금지**: PostToolUse가 pre file 못 찾으면 R4 2nd-pass orphan 절차로 진입해 STATE_RECORD_FAILED marker 기록(현 sid gate 차단). 부재를 새 SHA로 fallback하지 않는다.
    * Deny 시(특히 `OVERWRITE_RACE`/`STATE_RECORD_FAILED`)에도 PreToolUse hook은 본인이 만든 `pre/` 파일을 즉시 삭제한다(poisoned pre_sha 방지).
    * GC: **R6 precedence #5b에서 수행**(sessions/ GC와 같은 pass). 24시간 초과된 `pre/<sid>/*.write.json`/`.read.json` 파일을 best-effort unlink. G5 invariant(precedence #1~#3 mutation 금지) 준수 — hook 시작 시점에는 어떤 GC도 수행하지 않는다.
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
        GC 시 같은 sid의 baselines/<sid>.txt + verify-logs/<sid>/ + debug/<sid>.jsonl + pre/<sid>/ + failed/<sid>/ + **locks/stop-<sid>.lock + locks/stop-<sid>.recover.lock + sessions/<sid>.guard.lock + sessions/<sid>.tombstone** cascade unlink(eghs-migrate와 동일 정책). stop-lock/guard/tombstone류가 GC 대상에 포함되지 않으면 mid-hook crash 시 UUIDv4 sid 재사용 없음으로 인해 영구 orphan(§G5 위반). **순서**: `sessions/<sid>.guard.lock` 은 `sessions/<sid>.json` **이전**에 unlink(guard가 lease에 종속; lease unlink 후 guard 잔존 시 orphan).
    * Foreign-uid 또는 EPERM 케이스: 자동 GC는 lease를 건드리지 않는다. multi-user 환경에서 죽은 다른 uid lease가 영구 잔존하면 `eghs-migrate --force-foreign-cleanup`(admin 옵션)으로 수동 정리한다. `--force-foreign-cleanup`은 `migrate.lock` 획득 후 모든 foreign-uid lease 중 `renewed_ms`가 `session_stale_seconds × 2` 초과한 것만 삭제한다(보수적).
    * `eghs-migrate`는 `sessions/` 디렉토리가 비어있을 때만 동작한다(GC 후 평가). `locks/`도 **`admin-mutex.guard` 를 제외하고** 비어 있어야 한다(admin-mutex.guard는 CLI 조작의 mutex이므로 존재가 정상).
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
    * `eghs-migrate` precondition은 `locks/`가 다음 중 하나여야 한다: (a) `admin-mutex.guard`만 존재(admin op에 필수), (b) `admin-mutex.guard` 및 **모든 잔존 `stop-<sid>.lock` 및 `stop-<sid>.recover.lock`의 대응 sid lease가 sessions/에 없거나 dead lease**. (b) 조건이면 eghs-migrate의 step 4 sessions/ GC cascade에서 stop-lock류가 함께 삭제되므로(§R2.5 eghs-migrate step 4 참조) 별도 처리 불필요. 살아있는 lease를 가진 lock이 단 하나라도 있으면 종료. clean-install(state dir 자체 부재) 시 eghs-migrate는 abort — 부트스트랩은 eghs-init 책임.
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
        * `eghs-init --repair`는 다음 네 케이스에 한해 허용:
            1. `schema_version` **존재하지만 INVALID**(strict regex 위반).
            2. `schema_version` 정상이지만 state subdir 하나 이상 부재(부분 초기화/수동 삭제 회복).
            3. `schema_version` 정상 + 모든 subdir 정상 + **`fs-info.json` 부재**(수동 삭제/외부 정리 회복). FS_INFO_MISSING dead-end 방지: fs-info는 subdir도 아니고 schema_version과도 별개이므로 별도 case 필요.
            4. `schema_version` 정상 + 모든 subdir 정상 + **`fs-info.json` 존재하지만 `flock_ok !== true` 또는 corrupt JSON 또는 필수 필드(`schema_version`/`caseless_fs`/`flock_ok`/`fs_st_dev`/`fs_statfs_id`) 누락 또는 FS anchor(`fs_st_dev`/`fs_statfs_id`) 부재/불일치**(legacy cache from pre-R20 install, partial-write corruption, 또는 state dir이 다른 FS로 이동됨). fs-info.json 삭제 후 재 probe(#3.3 검증 항목과 정확히 일치).
          네 케이스 모두: subdir mkdir -p (idempotent) + 1번 케이스이면 schema_version atomic rewrite + 3/4번 케이스이면 fs-info.json probe 재수행 (5/6단계만 수행, schema_version 재작성 skip). 정상 schema + 모든 subdir + fs-info.json (flock_ok=true, anchor 일치) 존재인 상태에서 `--repair` 호출은 no-op + exit 0(idempotent). plain `eghs-init`은 네 케이스 모두 거부, `eghs-migrate`도 거부(stderr 안내).
    * **`eghs-migrate --clear-sid <SID>`** (lease/baseline corruption 회복 전용 관리자 명령): 손상된 개별 sid(대응 hook이 `INFRA_NOT_READY reason=lease_unavailable`을 반복 반환하는 경우)를 명시적으로 정리한다. 절차:
        0. **admin-mutex 획득** (`locks/admin-mutex.guard` LOCK_EX). eghs-init/eghs-migrate/--clear-migrate-lock/--clear-init-lock과 직렬화. 공통 순서: `admin-mutex → migrate.lock → sid guard`. timeout(예: 30s) 초과 시 abort.
        1. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득(다른 sid 활동 방해 최소화 위해 sessions/ empty 요구 안 함). 실패 시 admin-mutex 해제 후 abort.
        2. `sessions/<SID>.json` stat 및 body read (uid + pid 확인 위해).
        3. **UID 게이트**:
            - lease body의 `uid` != 현재 uid → **`--force-foreign-cleanup` 지정 필수**(단순 `--force`는 foreign-uid에 무효). `--force` 단독 지정 시 stderr `[eghs-migrate] sid <SID> foreign uid; use --force-foreign-cleanup instead` + 종료. `--force-foreign-cleanup` 지정 시 액세스 가능 여부(EACCES)만 확인 후 4단계 진행.
            - lease 파일 부재(baseline만 corrupt) → uid 검증 skip, 4단계 진행.
            - lease body parse 실패 → uid 미확인 상태. 파일 stat(`st_uid`)로 owner uid 확인 후 위 규칙 적용.
        4. **PID liveness rule** (uid gate 통과 후):
            - **lease body parse 실패 (PID 필드 부재/corrupt)** → PID liveness 판정 불가. `--force` 필수. `--force` 미지정 시 stderr `[eghs-migrate] sid <SID> lease body corrupt; --force required for cleanup` + 종료. `--force` 지정 시 tombstone+guard barrier 절차로 바로 진행(5단계). 이 경로 없이는 corrupt lease의 유일 escape hatch가 봉쇄됨.
            - pid dead(`kill(pid, 0)` ESRCH) → 5단계 진행.
            - pid alive AND `--force` 미지정 → stderr `[eghs-migrate] sid <SID> lease pid alive; refusing without --force` + 종료(비-zero exit).
            - pid alive AND `--force` 지정 → **tombstone 절차 필수** (race guard, 아래 5단계).
            - same-uid EPERM → 5단계 진행(sandbox/namespace 비정상은 dead로 간주하되 debug log 기록).
        5. **Tombstone + guard barrier (BLOCKER race close, §R6 #3.7 참조)**:
           a. `sessions/<SID>.tombstone` link(2) exclusive create. body `{cleared_by_pid, cleared_by_uid, ts_ms, reason: "clear-sid"}`.
              - EEXIST 시: 기존 tombstone body read → owner uid/pid 검증 (§R6 #3.7 "재개 절차"와 동일). foreign-uid 또는 alive/EPERM → abort. same-uid + dead → 기존 tombstone identity(inode + sha256) snapshot 후 5c로 진행(재개).
           b. **hook drain 관측**: `sessions/<SID>.guard.lock`에 대해 `open(O_RDWR|O_CREAT|O_CLOEXEC) + flock(LOCK_EX)` 시도 (blocking, timeout `wait_grace_ms=90000ms`). 성공 = 활성 hook 없음, 안전 진입. timeout = hook drain 지연, abort(stderr `hooks did not drain within grace; retry`; tombstone 잔존 → 후속 hook은 여전히 sid_cleared로 block, disk consistency 유지).
           c. (지웠음 — b에서 flock으로 drain 관측 통합)
        6. R2.5 sessions cascade delete와 동일한 절차 실행 (§R2.5 §238 + R6 #5b verbatim 동일 set): `sessions/<SID>.guard.lock` unlink(exclusive flock hold → close 이전에 unlink; lease보다 먼저) + `sessions/<SID>.json` unlink + `baselines/<SID>.txt` + `verify-logs/<SID>/`(rm -rf) + `debug/<SID>.jsonl` + `pre/<SID>/`(rm -rf) + `failed/<SID>/`(rm -rf) + `locks/stop-<SID>.lock` + `locks/stop-<SID>.recover.lock` + key-scoped `failed/<sha1(*)>.json` 중 `origin_sid == <SID>`인 것 unlink.
        7. `sessions/<SID>.tombstone` unlink (cleanup 완료 → 게이트 해제; UUIDv4 sid는 재사용되지 않으므로 tombstone 잔존해도 무해하지만 명시적 정리로 disk 사용 최소화).
        8. `migrate.lock` 해제 후 **admin-mutex 해제**. exit 0.
      본 명령은 `sessions/`가 비어있을 필요 없음(개별 sid 정리이므로). 안전 gate는 0단계 admin-mutex + 3단계 UID + 4단계 PID + 5단계 tombstone(race guard). corrupt-lease/corrupt-baseline 무한 loop의 유일 escape hatch.
    * **`eghs-migrate --clear-migrate-lock`** (corrupt/non-regular migrate.lock escape): 일반 eghs-migrate가 non-regular type 또는 corrupt body의 `migrate.lock`을 만나면 abort하는데, hook도 동일 case에서 `INFRA_NOT_READY reason=migrate_lock_corrupt` 반환 → self-heal 불가. 본 CLI는 lock 정리 전용:
        1. **`lstat("migrate.lock")` 로 type + owner 확인**(NOFOLLOW, symlink 자체 정보; FIFO에 open()해서 blocking 되는 위험 회피). ENOENT → no-op exit 0.
        2. **Type-분기 처리** (모든 branch가 `uid` gate 공통 적용: `st_uid != 현재 uid` → `--force-foreign-cleanup` 필수, 미지정 시 abort):
           - **symlink** (`S_ISLNK`) → 곧바로 `unlink` (target 접근 안 함, symlink attack 회피).
           - **FIFO/socket** (`S_ISFIFO`/`S_ISSOCK`) → `unlink` 로 즉시 제거(open 시 block 위험).
           - **directory** (`S_ISDIR`) → **비어있으면 `rmdir`, 안 비어있으면 abort**(수동 조사 필요; `rm -rf` 자동 금지 — data loss risk). stderr `directory not empty; manual cleanup required`.
           - **regular file** (`S_ISREG`) → **step 3으로 진행**.
           - 기타(character/block device 등) → abort(stderr `unexpected file type`; 수동 조사).
        3. **regular file case: identity snapshot + body 검증**:
           a. `open(O_RDONLY|O_NOFOLLOW)` + `fstat` → identity snapshot `(st_ino, st_dev, size, mtime_ns)` + body sha256 계산.
           b. body 검증:
              - body parse 실패 또는 `uid`/`pid`/`start_ms` 필드 sanity 실패 → corrupt 판정, step 4로.
              - body OK + `body.uid != st_uid` (심층 anomaly) → corrupt 판정, step 4로.
              - body OK + same-uid + `kill(pid, 0)` 성공 alive → abort(stderr `held by pid=<PID>`; live migrate 침해 금지).
              - body OK + same-uid + dead + grace 미경과 → abort(stderr `dead but within grace`).
              - body OK + same-uid + dead + grace 경과 → 정상 stale, step 4로.
        4. **Global mutex under migrate.lock alternative**: unlink TOCTOU race close 를 위해 **`locks/admin-mutex.guard`**(regular file, sid-agnostic) 을 `flock(LOCK_EX)`로 획득 (`--clear-sid`가 sid guard 쓰듯 lock 조작이 이 mutex 안에서만 발생). eghs-init/eghs-migrate/`--clear-migrate-lock`/`--clear-init-lock` 모두 mutex 안에서만 migrate.lock 및 .init.lock을 open/create/unlink 한다. mutex 획득 실패 시 abort(다른 admin op 진행 중).
        5. **mutex hold 상태에서 identity 재검증**: `lstat` 재수행 → 1단계 결과와 type 일치 확인. regular file case 는 `open+fstat+body sha256` 재수행 → 3a snapshot 전체(`st_ino, st_dev, size, mtime_ns, body_sha256`) 일치 필수. 불일치 → 다른 프로세스가 lock 새로 만든 상태 → mutex 해제 + abort(stderr `lock replaced during check; retry`). 최대 3회 retry.
        6. mutex hold 상태에서 `unlink`/`rmdir` 수행 후 mutex 해제. exit 0.
    * **`eghs-migrate --clear-init-lock`** (corrupt/non-regular `.init.lock` escape): 절차는 `--clear-migrate-lock`과 동일 (lstat type 분기 + identity snapshot + `locks/admin-mutex.guard` mutex + 재검증)하되 대상 파일은 `.init.lock`. 본 명령도 mutex 안에서만 조작. 이 공통 mutex로 admin lock ops(migrate.lock 및 .init.lock 관련)이 단일 직렬화되어 두 admin 동시 실행 시 fresh valid lock kill 방지.
* `eghs-init` 동작 절차(`migrate.lock` mutex 포함):
    0. **admin-mutex 획득 (bootstrap-safe)**: `.claude/state/eghs/locks/` 디렉토리를 `mkdir -p`로 idempotent 생성(state root과 locks/만 우선 생성; 나머지 subdir은 step 5에서). `locks/admin-mutex.guard`를 `open(O_RDWR|O_CREAT|O_CLOEXEC) + flock(LOCK_EX)`. 다른 admin op(--clear-migrate-lock/--clear-init-lock/eghs-migrate/eghs-init/--clear-sid) 진행 중이면 blocking. timeout(예: 30s) 초과 시 abort. 이 mutex 안에서만 migrate.lock/.init.lock 조작.
    1. `migrate.lock` stale 회수: hook precedence #4 stale rule을 적용. 다른 uid 또는 살아있는 lock 시 종료(mutex 해제).
    2. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득. lock 내용 `{pid, uid, start_ms, role: "init"}`.
    3. 역할 검증: `schema_version` 부재 확인 (또는 `--repair` 플래그 + (INVALID 또는 정상 schema + state subdir 일부 부재 또는 정상 schema + 모든 subdir 정상 + fs-info.json 부재/unhealthy 또는 정상 schema + 모든 subdir + fs-info.json 정상=no-op)). 위 mutex 정의 일치.
       * `--repair` 실행 시 Case별 단계 skip:
         - Case 1 (INVALID schema) → 5·6·7 모두 수행.
         - Case 2 (subdir 부재) → 5 수행, 6 조건부, 7 skip.
         - Case 3 (fs-info.json 부재) → 5 skip(모든 subdir 정상), 6 수행, 7 skip.
         - **Case 4 (fs-info.json unhealthy: `flock_ok !== true` OR corrupt JSON OR 필수 필드 누락 OR FS anchor 불일치)** → 5 skip, **기존 fs-info.json unlink 후 6 수행(재 probe)**, 7 skip.
         - Case 5 (모두 정상 = no-op) → 5·6·7 skip, exit 0(idempotent).
    4. `.init.lock` acquire(내부 단계 보호). **body: `{pid, uid, start_ms}`.** `.init.lock`이 이미 존재하면 stale 회수 규칙 적용(migrate.lock과 대칭 + §691 lease 검증과 대칭):
       * body parse 실패 → abort(stderr `[eghs-init] .init.lock body parse fail; remove <path>/.init.lock or run \`eghs-migrate --clear-init-lock\``).
       * body의 `pid` 필드 부재/음수/`> 2^53-1`, `start_ms` 필드 **부재/parse 실패/음수/`> 2^53-1`/`> now_ms + far_future_grace_ms`(기본 86400000 = 24h, §R6 lease sanity와 동일 constant 사용 — clock-skew NTP correction/VM resume 정상 범위 통과, 명백한 corruption만 차단), `uid` 필드 부재/parse 실패** → abort with stderr `[eghs-init] .init.lock body corrupt; use \`eghs-migrate --clear-init-lock\``. body가 JSON parse는 되지만 field-level sanity 실패도 corrupt case로 취급(silent deadlock 방지). **주의**: `init_lock_grace_ms`(60s)는 stale-dead lock 회수 grace(=lock life span 상한)이지 clock-skew tolerance가 아니다; 두 constant는 의미가 다르므로 절대 겹치지 마라(60s로 clock-skew 판정하면 NTP step correction에 false corrupt).
       * uid != 현재 uid → abort(stderr `[eghs-init] .init.lock foreign; aborting`).
       * same-uid + `kill(pid, 0)` 성공(alive) → abort(stderr `[eghs-init] .init.lock held by pid=<PID>; aborting`).
       * same-uid + `kill(pid, 0)` ESRCH(dead) + `start_ms + init_lock_grace_ms` (기본 60s) 경과 → stale 판정, unlink 후 재획득 1회. 그래도 실패 시 abort.
       * same-uid + dead + grace 미경과 → abort(짧은 crash 직후 보호). 사용자는 grace 경과 후 재시도.
       **init_lock_grace_ms=60s 근거**: init step 5(subdir mkdir) + step 6(fs-info probe) + step 7(schema_version atomic write)의 wall-clock 상한(로컬 FS 기준 수 초 수준)에 안전 마진 포함. 60s 초과 실제 실행 시 hang/deadlock 의심 신호. --repair 재시도 봉쇄 최대 60s는 disk-hot-recovery 목적상 허용 가능(수 초 wait으로 무한 봉쇄 대체).
       본 규칙 부재 시 SIGKILL/crash로 leak된 `.init.lock`이 향후 모든 `eghs-init`/`eghs-init --repair`를 영구 봉쇄(migrate도 `.init.lock`을 건드리지 않으므로 self-heal 경로 없음 → `--clear-init-lock` CLI 별도 제공).
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
    6. `fs-info.json` **unhealthy predicate** (§3.3와 정확히 일치) 이면 기존 파일 unlink 후 probe 절차(R2 참조)로 재생성: **부재 OR regular file 아님 OR size > 4KB OR JSON parse 실패 OR 필수 필드(`schema_version`/`caseless_fs`/`flock_ok`/`fs_st_dev`/`fs_statfs_id`) 누락/type 불일치 OR `flock_ok !== true` OR FS anchor(`fs_st_dev`/`fs_statfs_id`) 불일치**. 이 predicate 없이 Case 1(INVALID schema)만 처리하면 동반 fs-info 손상이 잔존해 hook이 계속 `INFRA_NOT_READY`로 차단됨. **flock capability probe**:
       a. 부모: `.claude/state/eghs/tmp/flock-probe.<pid>.<seq>` 경로 `parent_fd = open(O_RDWR|O_CREAT|O_CLOEXEC)` → `flock(parent_fd, LOCK_EX|LOCK_NB)`. 실패(ENOTSUP/EOPNOTSUPP/EINVAL/EWOULDBLOCK) → fail-closed(아래).
       b. `fork()` 후 자식: **상속 fd 사용 금지**. `close(parent_fd)` (또는 이미 O_CLOEXEC로 exec 후 별 프로세스에서 처리) → 동일 경로를 **별도로** `child_fd = open(O_RDWR|O_CLOEXEC)` (O_CREAT 없음, 이미 존재) → `flock(child_fd, LOCK_EX|LOCK_NB)`. **반드시 EWOULDBLOCK 반환해야 정상**. 성공 반환(자식이 lock 획득) 시 flock 지원 안 됨(silent no-op FS). ENOTSUP/EINVAL 등도 동일 실패 처리. 자식은 결과 코드를 exit로 반환.
       c. 부모: 자식 exit 값이 "EWOULDBLOCK expected" 아니면 **fail-closed**: stderr `[eghs-init] flock not supported on this filesystem (likely NFS/CIFS/silent-noop); EGHS requires local POSIX flock-capable FS` + 비-zero exit. 부모 lock 해제 후 probe 파일 unlink.
       d. 성공 시 `fs-info.json`에 다음 필드 추가: `"flock_ok": true`, `"fs_st_dev": <state root의 st_dev>`, `"fs_statfs_id": <platform-normalized FS type identifier>`. **Platform-normalized `fs_statfs_id`** (2026-08-01 개정 — 아래 "구현 형식"이 normative):
          * **구현 형식(normative)**: `"<process.platform>:<fs.statfsSync(stateRoot).type 10진수>"`. 예: `darwin:26`, `linux:61267`. 비교 시 tag+value 모두 일치해야 정상.
          * **개정 근거**: Node core는 어느 플랫폼에서든 `fs.statfsSync().type`(숫자)만 노출하며 macOS의 `statfs.f_fstypename` 문자열에 접근할 방법이 없다(fs-ext에도 statfs 없음). 원안(`"darwin:apfs"`)을 지키려면 네이티브 애드온이 필요한데, anchor의 목적(캐시된 probe 결과가 현재 볼륨의 것인지 확인)은 숫자 type으로 동일하게 달성된다 — 값의 가독성만 손해다.
          * 기존 원안(참고용, 더 이상 구현 기준 아님): Linux `statfs.f_type` 정수 / macOS·BSD `statfs.f_fstypename` 문자열 / 그 외 `"posix:<uname 값>"`.
          * `fs.statfsSync`가 실패하는 플랫폼: anchor 검증 불가로 취급(`anchor_unverifiable`) — self-heal 없이 fail-closed. 미지원 platform은 §3 Non-goal.
       hook은 매 실행마다 fs-info.json 읽어 `flock_ok !== true` 시 `INFRA_NOT_READY reason=infra_not_ready`로 fail-closed 반환(stderr `run: eghs-init --repair to re-probe`). 또한 매 hook 시작 시 state root의 `st_dev` + platform-normalized statfs id 를 확인해 fs-info.json cache와 불일치 시 **`.init.lock` 하 자동 재 probe self-heal을 시도** — 성공 시 fs-info.json 재작성 + stderr 경고 1줄 후 fresh 값으로 계속 진행, lock 경합/probe 실패 시 fail-closed `INFRA_NOT_READY`(2026-07-19 개정, 상세는 §R6 #3.3; APFS synthetic st_dev 재부팅 churn 대응). remediation은 `eghs-init --repair`. guard rwlock과 admin-mutex 정확성은 flock 지원에 종속되므로 미지원 FS는 지원 밖.
    7. `schema_version`을 R2.5 atomic write로 작성(**strict 형식 `^[1-9][0-9]*\n$` 최대 32바이트**; 코드 버전 ≥ 1). `0\n`이나 선행 0(`01\n`) 금지 — precedence #1 reader와 동일 규칙. **반드시 5/6단계 완료 후에 schema_version을 마지막으로 작성**(schema 존재 = 모든 인프라 준비 완료의 단일 signal).
    8. probe 파일, `.init.lock`, `migrate.lock` 순서로 삭제. **admin-mutex 해제**.
* `eghs-migrate` 동작 절차:
    0. **admin-mutex 획득**: `locks/admin-mutex.guard`를 `open(O_RDWR|O_CREAT|O_CLOEXEC) + flock(LOCK_EX)`. eghs-init/--clear-*와 직렬화. timeout(예: 30s) 초과 시 abort. (`locks/` 부재이면 abort — eghs-migrate는 부트스트랩 대상이 아니며 state dir 부재 시 eghs-init 필요.)
    1. `migrate.lock` stale 회수: 기존 `migrate.lock`이 있으면 hook의 precedence #4 stale rule(same uid + dead + grace 경과)을 그대로 적용. 다른 uid lock 또는 살아있는 lock 시 종료. **`--force-foreign-cleanup` 지정 시**: foreign-uid lock에 한해 stale 검증(uid stat + `kill(pid, 0)` ESRCH + `start_ms + foreign_migrate_lock_grace_ms` (기본 7200s) 경과) 후 unlink 허용(살아있는 foreign lock은 여전히 abort). 이 경로가 없으면 foreign-stale migrate.lock 감지 시(hook의 precedence #4에서 안내됨) `--force-foreign-cleanup` 실행 자체가 abort되어 self-heal 봉쇄. migrate.lock이 regular file이 아닌 비정상 type이면 stderr에 `[eghs-migrate] migrate.lock is not a regular file; use --clear-migrate-lock` 출력 후 비-zero exit(별도 CLI로 위임).
    2. `migrate.lock`을 `O_CREAT|O_EXCL`로 획득. lock 내용 `{pid, uid, start_ms, role: "migrate"}`.
    3. 역할 검증: `schema_version` 존재 + 파싱 성공 확인(INVALID이면 종료, init 안내).
    4. lock 획득 후 `sessions/` 디렉토리를 GC 절차(pid liveness + uid + TTL)로 정리. `--force-foreign-cleanup` 플래그가 있으면 foreign-uid stale lease도 정리. **각 GC된 sid에 대해 cascade delete** (R2.5 §238 + R6 #5b와 verbatim 동일 set): `baselines/<sid>.txt` unlink, `verify-logs/<sid>/` `rm -rf`, `debug/<sid>.jsonl` unlink, `pre/<sid>/` `rm -rf`, `failed/<sid>/` `rm -rf`(orphan sid-scoped marker도 정리), **`locks/stop-<sid>.lock` unlink, `locks/stop-<sid>.recover.lock` unlink**, **`sessions/<sid>.guard.lock` unlink**(lease unlink 이전), **`sessions/<sid>.tombstone` unlink**(orphan tombstone 회수). **모두 best-effort**: ENOENT와 EPERM 둘 다 silently skip. EPERM이 발생한 sid는 sessions/<sid>.json 자체 unlink도 함께 skip해 cascade desync 차단.
       **추가로 orphan stop-lock scan** (TTL-비의존 정리, precondition (c) 조건 충족용): `locks/` 디렉토리를 1회 scan해 `stop-<sid>.lock` 및 `stop-<sid>.recover.lock` 파일별로:
        * 대응 `sessions/<sid>.json`이 부재이거나 lease body pid가 dead(`kill(pid, 0)` ESRCH)이면 → orphan 판정, best-effort unlink. body가 alive이거나 same-uid EPERM이면 건드리지 않음(살아있는 Stop 침해 금지).
       본 scan은 TTL 무관하게 lease liveness만 확인 — 이 단계 없이는 crash된 short-lived 세션의 stop-lock이 TTL(기본 24h)까지 살아남아 precondition (c)를 실패시켜 step 5가 abort. senior R17 #5 fix.
    5. `sessions/`가 비어 있고 `locks/` precondition(상기 stop/recover lock 규칙)이 만족되면 schema 갱신 진행. 비어 있지 않으면 사용자에게 활성 세션 안내 후 lock 해제하고 종료.
    6. **Per-record schema 정리** (schema bump 시 v→v+1 마이그레이션): bump이면 다음을 수행 후 schema_version 파일 갱신.
        * `reads/*.json` 전체 unlink(GC TTL 무시, 즉시 삭제). cross-session evidence는 schema 변경 시 무효화하는 것이 가장 안전(evidence 손실은 다음 Read에서 재생성됨; G1 일관성 유지가 우선).
        * `failed/*.json` 전체 unlink(동일 이유).
        * `fs-info.json`은 schema-agnostic이므로 유지(단, fs-info schema_version 필드도 동일하게 bump하려면 `eghs-init --repair` 호출 안내).
        * 본 단계는 trace 모드(`--dry-run`)로 사전 검토 가능해야 한다(MVP 도구 §8).
        이 정책은 per-record body의 `schema_version` 필드 호환성 처리 코드를 hook에서 제거할 수 있게 해 단순성/안전성을 모두 확보한다. record의 자체 `schema_version` 필드는 디버깅/감사용으로만 유지하며, hook 동작 분기에는 사용하지 않는다.
    7. schema 갱신은 R2.5 atomic write 절차(destination-local tmp + fsync + same-dir rename + dir fsync)로 `schema_version` 파일을 갱신한다. 비-atomic truncate+write 금지.
    8. schema 갱신 완료 후 `migrate.lock` 삭제. **admin-mutex 해제**.
* hook은 매 호출 precedence #4에서 `migrate.lock`을 체크해 `eghs-migrate` 진행 중에는 hook-type 매트릭스에 따라 분류한다. 이는 `eghs-migrate` 본인의 lock 절차와 결합해 race를 차단.
* **Precedence #1 ↔ #6 TOCTOU 방어**: hook은 precedence #6(lease write) 직전에 `migrate.lock`을 재확인하고, lock이 존재하면 후보 `MIGRATE_IN_PROGRESS` → #4 매트릭스 적용. 또한 `disk_schema`를 #6에서 재읽기해 #1 시점 값과 다르면 동일 처리. 이로써 #1과 #6 사이에 migrate가 완주한 race도 안전하게 처리.

**Cross-session 정책**:

* `reads/`는 모든 세션이 공유한다. R3 gate는 state의 `sid` 필드가 현재 hook 호출의 sid와 일치할 때만 통과시킨다(G1).
* 즉, 다른 세션의 Read evidence는 사용하지 않는다. 같은 세션이 동일 파일을 Read하면 state를 갱신해 sid를 자기 것으로 채운다.
* failed marker는 sid + ts_ms tagged(R2 schema 참조). 다른 세션이 만든 marker는 현 세션 `sessions/<sid>.json`의 immutable `start_ms`보다 이전인 경우에만 self-clear 가능. 더 신 marker는 그 세션에서만 해제할 수 있다.

**sid 형식 규약**:

* `sid`는 **UUIDv4 lowercase string**(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)이어야 한다. Claude Code 본체가 제공하는 session_id가 이 형식을 만족한다고 가정한다.
* hook은 input의 `session_id`를 strict UUIDv4 regex로 검증한다. 위반 시 `NO_SESSION` deny로 처리(R3 enum 참조). PreToolUse는 fail-closed block, PostToolUse는 short-circuit exit 0. 자세한 hook 별 분기는 precedence #3.5 참조.
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
    1. PreToolUse는 `pre_sha: null`을 `pre/<sid>/<sha1(canonical_key)>.<tool_use_id>.write.json`에 기록하고 allow한다.
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

성공 시 hook은 `pre_sha = state.sha`를 `pre/<sid>/<sha1(canonical_key)>.<tool_use_id>.write.json`에 기록하고 allow(`exit 0`)한다.

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
| `INFRA_NOT_READY`          | state dir 부재 또는 schema_version 비정상 file type, lease 기록 ENOENT/EACCES, state subdir 부재 등 인프라 결함 | No | **reason 필드로 분기**: (a) `reason=infra_not_ready/schema_invalid` 등 인프라 결함 → `eghs-init` 실행 후 재시도(`--repair` 필요 시). (b) `reason=lease_unavailable` (corrupt-lease/baseline sanity fail) → **`eghs-migrate --clear-sid <SID>` 실행** (본인 sid이면서 활성인 경우 `--force` 추가). (c) `reason=sid_cleared` → tombstone 존재. Claude Code 세션 재시작(새 sid 발급). (d) `reason=migrate_lock_corrupt` → `eghs-migrate --clear-migrate-lock` 실행. (`.init.lock` corruption은 hook에서 도달 불가 — hooks는 `.init.lock`을 stat하지 않음; 오직 `eghs-init` CLI stderr 안내로 `--clear-init-lock` 실행.) |
| `SID_COLLISION`            | 같은 sid를 보유한 두 개의 활성 lease 감지 (anchor 불일치 + lease pid alive). Claude Code session_id 충돌 또는 구현 버그 신호. | No | hook 호출자 측 sid 발급 로직 점검; 한 세션 종료 후 재시도 |
| `FILE_UNREADABLE`          | realpath/stat 실패           | Yes (제한적) | 파일 권한/존재 확인 |
| `INPUT_PARSE`              | hook input JSON 파싱 실패     | Yes | 작업 재시도 |
| `NO_SESSION`               | hook input에 session_id 없음 또는 strict UUIDv4 regex 위반 | No | Claude Code sid 발급 로직 점검, 세션 재시작 후 재시도. Precedence #3.5에서 kill switch/CI passthrough 다음으로 평가. **PreToolUse Read/Write/Edit/MultiEdit는 fail-closed block**(G1 Read-before-Edit sid 없이 검증 불가). **PostToolUse는 short-circuit exit 0**(state 저장 위치 없음). **UserPromptSubmit는 fail-soft exit 0**(R1 사용자 입력 차단 금지). **Stop은 block auto-unblock=No**(G3) |

`Auto-unblock`이 No인 deny code는 R6 kill switch 외에는 우회 불가.

PreToolUse가 위 deny code 중 어느 하나라도 반환할 때, 본인이 작성했을 수 있는 `pre/<sid>/<sha1(key)>.<tool_use_id>.write.json` 임시 파일을 즉시 삭제한다(다음 호출에 stale pre_sha가 남지 않도록).

**MultiEdit 정책**:

* PreToolUse gate는 `file_path` 기준 1회 검사. SHA가 일치하면 모든 sub-edit을 통과시킨다.
* MultiEdit의 sub-edit 사이 race는 §3 Non-goal로 명시한다. Claude Code tool 구현이 sub-edit을 어떻게 적용하는지는 EGHS 보호 범위 밖.
* PostToolUse 결과는 R4 매트릭스로 처리.

---

### R4. Edit State Update

`PostToolUse Write|Edit|MultiEdit` hook은 결과를 다음 매트릭스로 처리한다.

**NO_SESSION 단락 (PreToolUse와 대칭)**:

* hook input에 `session_id`가 없거나 strict UUIDv4 regex를 위반하면 PostToolUse Write/Edit/MultiEdit/Read는 **즉시 short-circuit**: state write 없음, marker 기록 없음, `pre/` 조회 없음, debug log write 없음(sid 없어 `debug/<sid>.jsonl` 경로가 정의되지 않음), R4 매트릭스 진입 금지. 관측이 필요하면 stderr에 `[eghs] NO_SESSION: no state or debug write` 1줄만 출력 후 exit 0. 본 결정은 precedence #3.5 NO_SESSION 로직과 대칭.
* 이 분기 적용 후에야 아래 입력/매트릭스가 적용된다.

**입력**:
* `tool_response.error`: tool 실행 에러 유무.
* `pre_file`: 1차로 `pre/<posttool_sid>/<sha1(key)>.<tool_use_id>.write.json` 검색.
    * 1차 hit → 정상.
    * 1차 miss → 2차 검색:
        1. `pre/` 디렉토리를 1회 enumerate해 `<sid>` 서브디렉토리 목록을 수집한다. **enumerate 시점의 wall clock을 `enum_ms`로 기록**.
        2. 각 sid에 대해 `sessions/<sid>.json` lease를 stat. lease가 부재이거나 GC 조건(R2.5)을 만족하는 dead lease이면 "dead sid" 후보로 분류. **lease가 존재하면 본문을 읽어 `renewed_ms`를 보관**.
        3. dead sid 중 `pre/<dead_sid>/<sha1(key)>.<tool_use_id>.write.json`이 존재하는 sid를 orphan 후보로 본다. **각 orphan 후보의 pre file `mtime_ms`(`fstat` 결과)도 함께 보관**.
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
* PostToolUse는 마지막에 `pre/<sid>/<sha1(key)>.<tool_use_id>.write.json`을 삭제한다(crash 시 GC가 처리).
* `post_edit_success` state의 `sid` 필드는 `posttool_sid`. 위에서 `pretool_sid == posttool_sid` 보장 후 기록하므로 G1 invariant 유지.

**신규 파일 evidence**:

* new file success로 기록된 `post_edit_success`는 R3 gate 통과 조건을 만족한다. 신규 파일을 만든 직후 즉시 추가 Edit 가능.

**Failed marker key scope 정리** (sid-scoped vs key-scoped):

* **Key-scoped** `failed/<sha1(key)>.json`: PostToolUse Write/Edit/MultiEdit 본인의 결과(매트릭스의 partial apply, overwrite race 등)로 인한 marker. 현 sid의 후속 Edit 차단이 의도.
* **Sid-scoped** `failed/<owner_sid>/<sha1(key)>.json`: 다른 세션의 in-flight write에서 유래한 orphan/cascade marker, 또는 #4/#3.7 매트릭스 fail-closed marker(migrate_in_progress/infra_not_ready/sid_collision/lease_unavailable/schema_invalid/sid_cleared/migrate_lock_corrupt). 자기 sid(owner_sid == current_sid)에만 영향, cascade GC됨.
* **R3 gate 조건 5는 두 경로 모두 검사**: `failed/<sha1(key)>.json` (key-scoped) AND `failed/<current_sid>/<sha1(key)>.json` (sid-scoped). 둘 중 하나라도 존재하면 marker 해제 정책 적용; 해제 불가면 deny.
* GC: sid-scoped는 `failed/<sid>/` 디렉토리가 sessions GC 시 cascade delete됨. key-scoped는 기존 R2 marker GC + 해제 정책 적용.

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

* 하나라도 non-zero exit이면 exit 2 + **stderr**에 `[eghs] block <deny_code>: <reason> sid=<sid>` 형식으로 실패 check 이름·exit code를 출력한다. (Claude Code Stop hook 계약: exit 2에서 stdout은 파싱되지 않고 stderr가 모델 피드백이 된다. allow는 exit 0 + 빈 stdout — `decision:"allow"` JSON은 Claude Code 출력 스키마(zod, decision enum `approve|block`)에 걸려 검증 실패한다.)
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
* `NO_SESSION`
* Stop verification failure

즉, evidence 부족이나 SHA mismatch는 자동으로 우회하지 않는다.

**평가 순서 (precedence)**:

각 hook 진입 직후 다음 순서로 평가한다. 먼저 매칭되는 조건이 이긴다. **Hook 종류별 분기 포함**.

**중요한 invariant**: precedence **#1~#3.7** (schema stat + kill switch + CI passthrough + flock capability 검증 + NO_SESSION validation + sid tombstone) 은 **state mutation 절대 금지**(stat/env/parse만). **허용 예외 2건**: ① #3.7 guard.lock create(아래 #3.7 참조), ② #3.3 anchor 불일치 시 `.init.lock` 하 fs-info 재 probe/재작성(2026-07-19 개정, 아래 #3.3 참조). 그 외 state mutation은 #4 이후에만 발생. kill switch/CI passthrough가 set이면 mutation 절차에 진입조차 안 한다. 이는 G5 ("즉시 비활성화 가능") + §R6 "kill switch 환경에서 disk leak 없음" 보장의 단일 근거. **순서**: schema stat(#1) → kill switch(#2, G5 최우선) → CI passthrough(#3) → flock 검증(#3.3) → NO_SESSION(#3.5) → sid tombstone(#3.7). kill switch는 fs-info 손상 시에도 반드시 우선 통과.

1. **on-disk schema_version 읽기 (stat-only, mutation 없음)**: `.claude/state/eghs/schema_version`을 stat. mkdir/생성하지 않음.
    * 파일 부재 또는 state dir `ENOENT` → `disk_schema = null` (NOT_INITIALIZED 신호).
    * regular file이 아닌 비정상(디렉토리/symlink 끊김/소켓/FIFO 등) → `disk_schema = INVALID`.
    * regular file이지만 size > 32 bytes → `disk_schema = INVALID`(읽지 않음).
    * regular file이고 size ≤ 32 bytes → 읽어서 **strict 검증**: 정확히 정규식 `^[1-9][0-9]*\n$` 매칭이어야 한다(BOM 금지, 선행 0 금지, 선행/후행 공백 금지, 추가 개행 금지, NUL 금지). 모든 위반 → `disk_schema = INVALID`. 매칭 성공 시 정수 부분만 파싱해 `disk_schema = <int>`.
    * `disk_schema == INVALID`는 NOT_INITIALIZED와 **명확히 구분**(아래 #7 분류 참조). INVALID은 fail-OPEN을 절대 허용하지 않는다.
2. **Kill switch** (stat/env 검사만, mutation 없음): `.claude/eghs-off` regular file 또는 `EGHS_DISABLED=1`이면 즉시 exit 0. 모델 우회 risk는 §3 non-goal로 명시. stderr에 `[eghs] kill-switch active: <reason>` 1줄 로그 외 어떤 disk write도 없음. **G5 즉시 비활성화 보장**: kill switch는 fs-info.json corruption과 무관하게 반드시 통과되어야 하므로 #1.5 fs-info 검증보다 **앞선다**.
3. **CI passthrough** (env 검사만, mutation 없음): Stop hook을 제외한 hook에서만 적용. `CI=true/1`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `BUILDKITE=true` 중 매칭 시 exit 0. Stop은 G3 보장을 위해 CI에서도 verification을 강제하므로 본 단계를 건너뛴다.
3.3. **fs-info.json flock capability 검증 (stat + read only; 단 anchor 불일치 self-heal 재 probe는 mutation-free invariant 예외 #2 — 2026-07-19 개정)** — R2.5 eghs-init step 6 flock probe로 캐시된 값을 hook이 신뢰하기 전에 검증. kill switch(#2)/CI passthrough(#3) 통과 후에만 도달. **#1에서 결정된 `disk_schema`를 사용**: `disk_schema == null` 이면 부트스트랩 전이므로 본 단계 skip → 다음 단계 fall-through(#7에서 NOT_INITIALIZED 분기). `disk_schema != null` (INVALID 포함) 이면 다음을 수행:
    * `fs-info.json` 부재 → `FS_INFO_MISSING` 후보 (#4/#7 분기에서 처리).
    * `fs-info.json` 파일 존재하지만 **regular file 아님/size > 4KB/JSON parse 실패/필수 필드(`schema_version`, `caseless_fs`, `flock_ok`, `fs_st_dev`, `fs_statfs_id`) 중 하나라도 누락 또는 type 불일치** → `INFRA_NOT_READY reason=infra_not_ready`, stderr `[eghs] fs-info.json corrupt; run: eghs-init --repair` 안내(legacy cache 및 partial-write 회복 경로 통합).
    * 읽기 성공하지만 `flock_ok !== true` → `INFRA_NOT_READY reason=infra_not_ready` 반환, stderr `run: eghs-init --repair`.
    * `flock_ok === true` 이지만 현재 state root `st_dev` + platform-normalized FS type identifier가 cache의 `fs_st_dev`/`fs_statfs_id`와 불일치 → **FS 이동/anchor 변경 감지** — 즉시 fail-closed하지 않고 **`.init.lock` 하 자동 재 probe self-heal을 시도**한다(2026-07-19 개정; macOS APFS synthetic st_dev가 재부팅마다 변해 false-deny를 유발 — anchor의 목적은 "cache가 현재 volume의 probe 결과"임을 보장하는 것이므로 재 probe가 그 보장을 직접 복원):
        * `.init.lock` 단일 non-blocking 생성(`O_CREAT|O_EXCL`, eghs-init step 4와 동일 JSON body) 성공 + probe 성공 → `fs-info.json` v2 재작성(새 anchor + 새로 probe한 `caseless_fs`/`flock_ok`), stderr 1줄 `[eghs] fs-info anchor changed — re-probed` 후 **fresh 값으로 hook 계속 진행**(deny 없음). hook은 admin-mutex를 보유하지 않으므로 기존 `.init.lock`의 stale 판정/reclaim은 절대 수행하지 않는다(create-only — 예외 #1 guard.lock create와 동일 원칙).
        * `.init.lock` EEXIST(다른 admin op 또는 동시 self-heal 진행 중) 또는 probe 실패 → `INFRA_NOT_READY reason=infra_not_ready` 반환(기존 fail-closed 유지), stderr `run: eghs-init --repair to re-probe FS`. anchor 외 unhealthy 사유(corrupt/필드 누락/`flock_ok !== true` 등)는 본 self-heal 대상이 아니며 위 분기 그대로 fail-closed.
    * 모두 정상 → 다음 단계. **이 검증 없이 #3.7 flock에 의존하면 broken-NFS legacy cache에서 silent no-op flock 통과 → guard/tombstone 무력화**.

3.5. **NO_SESSION strict validation (mutation 없음, #2 kill switch와 #3 CI passthrough 뒤에서만 도달)**: hook input JSON을 파싱해 `session_id` 필드를 strict UUIDv4 regex(R3 §)로 검증. 위반 또는 부재 시 hook 종류별 분기 — **`PreToolUse Write/Edit/MultiEdit` 및 `PreToolUse Read`는 fail-closed** (G1 Read-before-Edit는 sid 없이는 원천 검증 불가):
    * `PreToolUse Write/Edit/MultiEdit`: **block, `deny_code: NO_SESSION`, auto-unblock=No.** state write 없음. Claude Code sid 발급 로직 이상 신호 → 사용자에게 stderr 안내(session_id 재발급 후 재시도). 모델이 sid 삭제로 gate 우회하는 시나리오도 본 fail-closed로 방어.
    * `PreToolUse Read`: **block, `deny_code: NO_SESSION`, auto-unblock=No.** Read evidence가 저장될 sid 위치 자체가 없어 후속 Write/Edit이 어차피 `UNREAD_OR_STALE`로 실패 → fail-fast가 정답.
    * `PostToolUse Write/Edit/MultiEdit/Read`: 즉시 short-circuit. state write/marker/pre 조회 skip. exit 0(R4 NO_SESSION 단락).
    * `UserPromptSubmit`: additionalContext 없음, normal exit 0(R1 fail-soft, 사용자 입력 차단 금지).
    * `Stop`: block, `deny_code: NO_SESSION`, auto-unblock=No(G3: verification 실행 안 했으므로 자동 통과 금지).
    본 단계는 stat/parse만 수행(어떤 state file도 만들지 않음, debug log도 없음 — sid 없어 `debug/<sid>.jsonl` 경로 미정). 관측은 stderr 1줄(`[eghs] NO_SESSION: <hook_type>`)만 허용. 본 검사 후에야 #3.7이 시작된다. **kill switch/CI passthrough가 앞선 #2/#3에서 이미 exit 0시켰다면 본 단계는 도달 불가** — 즉 kill switch가 NO_SESSION보다 무조건 우선.

3.7. **Sid tombstone check + shared guard acquire (POSIX `flock(2)` 커널 rwlock으로 race 완전 close)**:

    이전 세대의 "stat 후 mutation 직전 재확인" 방식은 stat→mutation 사이 race를 못 닫는다. 커널 lock으로 대체.

    **파일 정의**:
      * `sessions/<sid>.guard.lock` (empty regular file, 0600 권한). 존재 자체가 sid mutation 활동 중 signal. lifetime = sid 활동 개시 첫 hook의 #3.7 create ~ `--clear-sid` cascade unlink.
      * `sessions/<sid>.tombstone` (JSON body `{cleared_by_pid, cleared_by_uid, ts_ms, reason}`; link(2) exclusive create). 존재 = sid 삭제 진행/완료.

    **Hook 절차 (#3.7)**:
      **0. Precondition — `disk_schema == null` (NOT_INITIALIZED) fast-path**: #1에서 `disk_schema=null` 이면 state dir 자체 부재 → 활성 sid state가 존재할 수 없다 → guard 획득 skip, tombstone stat skip, 즉시 #4로 fall-through (#7에서 최종 `SCHEMA_NOT_INITIALIZED` 분기 처리). guard.lock create시도 자체가 clean-install 시나리오에서 ENOENT crash 유발하므로 필수 skip.
      1. `sessions/<sid>.tombstone` stat. 존재 시 즉시 `INFRA_NOT_READY reason=sid_cleared` 반환 (mutation-free short-circuit; guard 획득 시도 안 함).
      2. `open("sessions/<sid>.guard.lock", O_RDWR|O_CREAT|O_CLOEXEC, 0600)` → guard fd 확보.
         - **ENOENT** (parent `sessions/` 자체 부재; `disk_schema != null`인데 subdir 수동 삭제된 상태) → 즉시 `INFRA_NOT_READY reason=infra_not_ready` 반환, stderr `run: eghs-init --repair` 안내. mutation-free skip.
         - **EACCES/기타** → 즉시 `INFRA_NOT_READY reason=infra_not_ready` 반환.
         - 파일 부재 시 생성됨(**이 create는 mutation invariant 예외로 허용 — kill switch(#2)와 NO_SESSION(#3.5) 통과 후이므로 kill-switch 환경 disk-leak 없음, G5 유지**; CI passthrough(#3)은 Stop 제외이므로 CI 환경 Stop만 예외적으로 guard 생성 → 정상 session lifecycle 하 § R6 #5b cascade GC로 회수).
      3. `flock(fd, LOCK_SH|LOCK_NB)` 시도.
         - EWOULDBLOCK → `--clear-sid`가 이미 exclusive 대기/획득 중. 즉시 fd close + `INFRA_NOT_READY reason=sid_cleared` 반환.
         - 성공 → shared 획득.
      4. **shared 획득 직후 tombstone stat 재확인** (race window: 다른 process가 step 1과 step 3 사이에 tombstone create).
         - 존재 → shared 해제(fd close) + `INFRA_NOT_READY reason=sid_cleared` 반환.
         - 부재 → 진행.
      5. hook lifecycle 전체(precedence #4-#8 + 모든 state mutation)를 이 shared hold 상태로 수행.
      6. hook exit 시 fd close (커널이 flock 자동 해제).

    **`--clear-sid` 절차 (§R2.5 step 5 → 6)**:
      * step 5a: `sessions/<sid>.tombstone` link(2) exclusive create. EEXIST 시 **기존 tombstone owner 검증** (아래 "재개 절차" 참조).
      * step 5c: `open("sessions/<sid>.guard.lock", O_RDWR|O_CREAT|O_CLOEXEC, 0600)` + `flock(fd, LOCK_EX)` (blocking, timeout `wait_grace_ms=90000ms`).
        - 성공 → 진행. 이 시점 모든 활성 hook은 이미 종료 완료.
        - timeout → hook drain 지연 이례적. abort(stderr `hooks did not drain within grace`; 재시도 안내). tombstone은 잔존 → 다음 hook은 여전히 sid_cleared로 block, disk consistency 손상 없음.
      * step 6: cascade delete (guard.lock unlink 포함).

    **`--clear-sid` 재개 절차 (BLOCKER — 중단된 clear-sid 회복 경로)**:
      * step 5a EEXIST 시 tombstone body 확인 → `cleared_by_uid != 현재 uid` → abort(foreign lock).
      * `cleared_by_uid == 현재 uid`:
        - `kill(cleared_by_pid, 0)` 성공(alive) → **다른 --clear-sid 진행 중** → abort(stderr `another --clear-sid running`).
        - ESRCH(dead) → **owner crash**. tombstone identity(inode + body sha256) snapshot 후 step 5c로 진행. 즉 기존 tombstone을 barrier로 재활용해 cascade 재개(자동 sweep 3600s 대기 불필요).
        - same-uid EPERM → 보수적으로 alive 취급 abort.

    **원자성 보장**: shared holder 존재 중에는 exclusive blocked. shared holder들의 모든 state-dir mutation(pre/, sessions/, baselines/, failed/ key-scoped, failed/ sid-scoped, verify-logs/, debug/, locks/stop-*, reads/ cross-session)이 --clear-sid cascade와 완전 배타. per-mutation re-stat 열거 삭제, **단일 규칙: "모든 sid-scoped state-dir mutation은 shared guard hold 상태에서만 수행"**.

    **flock 특성**: 프로세스 종료 시 커널 자동 해제 → dangling risk 없음. `flock(LOCK_NB)` fast path syscall ~1μs, §R5 hook budget(p95 100ms) 침해 없음.

    본 단계는 mutation-free invariant의 예외 #1(guard.lock create; 예외 #2는 #3.3 anchor self-heal 재 probe — 2026-07-19 개정): kill switch(#2)와 NO_SESSION(#3.5) 통과 후에만 create이 발생하므로 kill-switch/no-sid 환경에서 disk write 없음(G5 유지). CI passthrough(#3)는 Stop hook 제외 규칙(§CI passthrough)에 따라 CI 환경 Stop만 예외적으로 #3.7 진입 — 이 경우 guard.lock은 정상 sid lifecycle에 종속되어 §R6 #5b sessions cascade GC로 회수(cascade 목록에 guard.lock 포함).
4. **migrate.lock 체크 (state mutation 가능: stale lock 삭제)**: `.claude/state/eghs/migrate.lock` stat 후 다음 분기. 본 단계가 반환하는 모든 deny code는 **hook 종류별 재분류 매트릭스**(아래 표)를 통과한 결과를 반환한다.
    * 부재 → 다음 단계.
    * regular file이고 lock content 파싱 실패(open ENOENT race, JSON 깨짐 등) → 본 결정 보류, retry 1회 후 여전히 실패면 hook-type 매트릭스로 `INFRA_NOT_READY` 반환. **PostToolUse Write/Edit/MultiEdit의 marker `reason=migrate_lock_corrupt`로 표기**(원 root cause 보존; user에게 `--clear-migrate-lock` 안내).
    * regular file이고 lock content의 `uid` == 현재 hook uid이며 `kill(pid,0)` 성공 → 후보 `MIGRATE_IN_PROGRESS`.
    * regular file이고 same uid이지만 `kill(pid,0)` EPERM(PID namespace/sandbox 등 비정상) → 후보 `MIGRATE_IN_PROGRESS`(liveness 판정 불가, fail-closed).
    * regular file이지만 `uid` != 현재 hook uid:
        * lock의 `start_ms + foreign_migrate_lock_grace_ms`(기본 7200s = 2h) 미경과면 후보 `MIGRATE_IN_PROGRESS`(다른 사용자 migrate 진행 가정).
        * grace 경과면 foreign-stale 추정 → 후보 `INFRA_NOT_READY`. stderr에 `eghs-migrate --force-foreign-cleanup` 실행 안내. 자동 삭제는 권한 risk로 인해 수행하지 않음.
    * regular file이고 same uid + `kill(pid,0)` ESRCH(dead) + `start_ms + migrate_lock_grace_ms`(기본 600s) 경과 → stale 판정, 삭제 후 다음 단계.
    * regular file이지만 same uid + dead + grace 미경과 → 후보 `MIGRATE_IN_PROGRESS`(짧은 crash 직후 보호 기간).
    * regular file이 아닌 비정상 type → 후보 `INFRA_NOT_READY`(인프라 결함). `FILE_UNREADABLE` 아님(자동 우회 금지). **PostToolUse marker `reason=migrate_lock_corrupt`로 표기** (파일형 corrupt).

    **Hook-type 재분류 매트릭스**(후보 → 실제 반환): G3/R1 보장을 위해 hook별로 결과를 다르게 분류한다.

    | Hook | 후보 `MIGRATE_IN_PROGRESS` | 후보 `INFRA_NOT_READY` | 후보 `SID_COLLISION` |
    | --- | --- | --- | --- |
    | `UserPromptSubmit` | stderr warning + additionalContext "migrate in progress" 1줄 + **normal exit 0** (R1 fail-soft, 사용자 입력 차단 금지) | 동일하게 fail-soft normal exit | 동일하게 fail-soft normal exit + additionalContext "sid collision detected, check Claude Code sid uniqueness" |
    | `Stop` | **block, auto-unblock=No** (G3: verification 실행 안 했으므로 자동 통과 금지). deny_code는 `INFRA_NOT_READY` (auto-unblock=No)로 마스킹해 반환. 원본 후보는 debug log에만 기록. | block, auto-unblock=No | block `SID_COLLISION`, auto-unblock=No |
    | `PostToolUse Write/Edit/MultiEdit` | **fail-closed marker 기록 후 exit 0**: 현재 sid의 sid-scoped marker `failed/<sid>/<sha1(key)>.json`을 `reason=migrate_in_progress`로 atomic 작성(가능하면; state dir write 권한 없으면 best-effort), `pre/<sid>/<sha1(key)>.<tool_use_id>.write.json`은 unlink. 후속 PreToolUse가 `STATE_RECORD_FAILED`로 정확한 root cause 차단. | 동일 처리(`reason=infra_not_ready`). | 동일 처리(`reason=sid_collision`). |
    | `PostToolUse Read` | state write skip, exit 0 (read-only fallback). | 동일. | 동일. |
    | `PreToolUse Write/Edit/MultiEdit` | block `MIGRATE_IN_PROGRESS` (auto-unblock=Yes). 본인이 만든 pre file 즉시 unlink. | block `INFRA_NOT_READY` (auto-unblock=No). | block `SID_COLLISION` (auto-unblock=No). pre file 즉시 unlink. |
    | `PreToolUse Read` | block `MIGRATE_IN_PROGRESS` (auto-unblock=Yes). pre file unlink. | block `INFRA_NOT_READY` (auto-unblock=No). | block `SID_COLLISION` (auto-unblock=No). pre file unlink. |

    위 매트릭스는 동일하게 precedence **#6 lease 작성 실패(EEXIST 제외)** 시에도 적용된다(중복 명세 제거를 위해 본 표를 참조).
5. **recover.lock GC + sessions/ GC + state subdir 검증** (state mutation): kill switch와 CI passthrough를 통과한 후에만 진입.
    a. **recover.lock GC**: state dir 존재 시 `locks/` 디렉토리를 1회 scan해 자기 uid 소유의 stale recover.lock(`kill(pid,0)` ESRCH + `start_ms + recovery_grace_ms` 경과)을 best-effort unlink. foreign-uid는 건드리지 않음.
    b. **sessions/ GC** (R2.5 정책): `sessions/<sid>.json` 중 (renewed_ms stale + same uid + pid dead) 조건 만족하는 lease를 GC 후보로 식별. **처리 순서 (원자성 아니지만 재시도 가능성 보존)**:
        1. **cascade delete 먼저 (lease 유지 상태에서)**: 각 target을 아래 semantics로 처리 — 파일은 `unlink`, 디렉토리는 **재귀 삭제**(entries 모두 unlink 후 rmdir): `baselines/<sid>.txt`(파일) + `verify-logs/<sid>/`(**재귀**) + `debug/<sid>.jsonl`(파일) + `pre/<sid>/`(**재귀**) + `failed/<sid>/`(**재귀**) + `locks/stop-<sid>.lock`(파일) + `locks/stop-<sid>.recover.lock`(파일) + **`sessions/<sid>.guard.lock`(파일; lease 이전 unlink 필수)** + **`sessions/<sid>.tombstone`(파일)** (crash 남긴 tombstone 회수 목적, --clear-sid 진행 중이면 tombstone 자체가 존재 신호 → 본 GC 진입 안 됨). 모두 best-effort. 재귀 삭제 실패 시(entry EPERM/EACCES) 해당 dir 자체 실패로 취급 → 아래 결과 분류 진입.
        2. **결과 분류**:
           - 모두 성공(ENOENT 포함) → 최종 단계로 진행.
           - EPERM/EACCES 등 진짜 실패 발생 → **lease 유지**(unlink 금지). 다음 GC pass에서 재시도할 수 있도록 sid를 GC candidate 상태로 남긴다(sid-scoped marker의 유일 GC 경로가 sessions cascade이므로 lease 선삭제 시 orphan 영구화). debug log에 `event: "sessions_gc_partial"` + `{sid, failed_targets: [...]}` 기록.
        3. **최종: cascade 성공 시에만 lease unlink**: `sessions/<sid>.json`을 best-effort unlink. 이 시점 실패는 다음 pass에서 자연 회수.
        stop-lock 포함 이유: mid-Stop crash 후 sessions GC 하나로 cleanup 완료(UUIDv4 sid 재사용 없음 → 자체 stale rule로는 절대 회수 안 됨).
        **본 단계는 pre/ 디렉토리의 24h 초과 파일 GC도 함께 수행**(정책은 R2.5 pre/<sid>/ 정의 참조). "hook 시작 시 자동 GC" 표현은 legacy — 실제 GC는 오직 이 #5b에서만 발생(G5 invariant 준수).
        **orphan tombstone sweep** (crash-safe): `sessions/*.tombstone` 중 sibling `sessions/<sid>.json` 및 sibling 모든 cascade target(baselines/verify-logs/debug/pre/failed/locks stop-*)이 모두 부재이고 tombstone body `ts_ms + tombstone_stale_seconds`(기본 3600s) 경과인 파일을 best-effort unlink. --clear-sid crash로 leaked된 tombstone이 disk에 축적되는 것을 방지(G5 disk-leak-free 유지). 같은 uid 소유만 대상, foreign-uid tombstone은 건드리지 않음.
    c. **state subdir 검증**: subdir(`tmp/`, reads/, reads/tmp/, failed/, failed/tmp/, pre/, locks/, locks/tmp/, sessions/, sessions/tmp/, baselines/, baselines/tmp/, verify-logs/, debug/) 중 하나라도 부재면 다음 분기:
       * **`disk_schema == null` (state dir 자체 부재 또는 schema_version 부재)**: clean-install 시나리오로 판정 → 본 단계 검사 skip, #7 `NOT_INITIALIZED` 분기로 위임(`eghs-init` 실행 안내). subdir-only-missing과 분리 처리해 부트스트랩 봉쇄 방지.
       * **`disk_schema == hook_version` (정상 schema + subdir만 일부 부재)**: 부분 초기화/수동 삭제 회복 시나리오 → **`INFRA_NOT_READY`** 후보로 #4 매트릭스 적용. remediation은 `eghs-init --repair` (아래 §R2.5 eghs-init --repair 정의 참조).
       * **그 외(INVALID/MISMATCH + subdir 부재)**: `INFRA_NOT_READY` 후보로 #4 매트릭스. 본 단계에서 디렉토리 절대 생성 금지. eghs-init이 단일 부트스트랩 책임.
6. **세션 lease 기록** (state mutation): #4/#5 통과 후 다음 절차.
    1. `migrate.lock`을 stat-only로 재확인. 존재하면(precedence #4 시점 이후 새로 생긴 경우) `MIGRATE_IN_PROGRESS` 후보 → #4 매트릭스 적용.
    2. `schema_version` 파일을 재읽기해 `disk_schema_now` 획득. `disk_schema_now != disk_schema`이면 `MIGRATE_IN_PROGRESS` 후보 → #4 매트릭스 적용(이는 migrate가 #1과 #6 사이에 완주한 race).
    3. `disk_schema_now`가 hook 코드 버전과 **일치**하고 정상 case일 때만 lease/baseline 작성:
        * `sessions/<sid>.json` create/renew 분기 (normative semantics):
            - **stat 결과 부재** → **link(2) 기반 exclusive create** (rename(2) 금지 — silent overwrite로 concurrent create가 `start_ms` clobber). `stop-<sid>.lock` 동일 패턴: body(`{schema_version, pid: current claude-code-pid, uid, start_ms: now_ms, renewed_ms: now_ms}`)를 `sessions/tmp/<sid>.<pid>.<seq>`에 fsync 후 `link(2)`로 `sessions/<sid>.json`에 이동. EEXIST면 다른 hook이 동시 create — tmp file unlink 후 stat 재수행해 결과의 분기로 진입(존재 → pid 검사). 성공 시 tmp unlink + 상위 dir fsync.
            - **stat 존재 + body.pid == current_pid** → **renew**: 본문 read → `renewed_ms`만 갱신 → R2.5 rename(2) atomic write로 overwrite (본인 소유 lease body를 자기 자신이 갱신하므로 clobber risk 없음, `start_ms`는 절대 변경 금지).
            - **stat 존재 + body.pid != current_pid** → **lease body 절대 overwrite 금지**. body를 그대로 보존하고 6.3b 분기로 진입(아래 anchor 검증에서 적절한 분류).
        * `baselines/<sid>.txt` 작성 — **anchor-bound + link(2) exclusive** 절차:
            a. 존재하지 않으면 **link(2) 기반 exclusive create**(R2.5의 `locks/stop-<sid>.lock` 동일 패턴): `baselines/tmp/<sid>.<pid>.<seq>`에 본문 작성 + fsync → `link(2)`로 최종 경로로 이동(EEXIST 시 다른 hook이 선점, 3b 분기로 진입). rename(2)은 사용 금지(overwrite 허용으로 anchor guard 무력화됨). 본문 = JSON `{"commit": "<rev-parse HEAD or NO_GIT>", "lease_start_ms": <sessions/<sid>.json.start_ms>, "lease_pid": <sessions/<sid>.json.pid>}`. **lease_pid는 baseline 작성자가 직접 보는 PID가 아니라 sessions/<sid>.json body의 pid 필드 값을 그대로 복사**(앵커 일관성 보장).
            b. 존재하면 본문을 읽어 anchor 검증 후 **단일 결정 트리** (b와 c는 mutually exclusive, 아래 순서대로 평가 — 먼저 매칭되는 분기가 이김):
               1. **anchor 일치 AND sessions.pid == current claude-code-pid** (anchor `lease_start_ms == sessions.start_ms` AND `lease_pid == sessions.pid` AND `sessions.pid == current_pid`) → **reuse OK**, 정상 종료. pid 동일성 검사는 foreign-pid가 살아있고 anchor도 우연 일치하는 SID_COLLISION 미감지 방지(G1 보호).
               2. **anchor 일치 AND sessions.pid != current_pid AND sessions.pid alive** (`kill(sessions.pid, 0)` 성공 or **same-uid EPERM**(PID namespace/sandbox 비정상)) → **6.3c SID_COLLISION 분기**. fail-closed.
               3. **anchor 불일치 AND sessions.pid alive** (`kill(sessions.pid, 0)` 성공 or same-uid EPERM) → **6.3c SID_COLLISION 분기**. 본 stale-cleanup 절대 실행 금지(살아있는 lease 침해 금지).
               4. **sessions/<sid>.json 부재** OR **anchor 불일치 AND lease pid dead(ESRCH)** OR **anchor 일치 AND lease pid dead(ESRCH)** OR **(baseline JSON parse 실패 AND sessions.pid dead(ESRCH))** → **stale-cleanup 분기**(절차 i–vi). **baseline parse 실패 AND sessions.pid alive는 여기 진입 금지**: 살아있는 lease cascade-unlink 시 concurrent Stop verification/other hook 침해. 이 조합은 아래 5/6번 분기로 분류.
               5. **baseline JSON parse 실패 AND sessions.pid == current_pid alive** → **후보 `INFRA_NOT_READY`** (#4 매트릭스 적용, `PostToolUse Write/Edit/MultiEdit`의 marker `reason=lease_unavailable`). 자기 자신의 lease + 자기 baseline 손상이므로 SID_COLLISION 아님(다른 세션 존재 신호 없음). lease/baseline **절대 unlink 금지**(살아있는 lease 침해 금지). **remediation: `eghs-migrate --clear-sid <SID> --force`** 실행(현 세션 종료 후 또는 `--force` 승인). `eghs-init --repair`는 baselines/를 건드리지 않으므로 자동 회복 불가.
               6. **baseline JSON parse 실패 AND sessions.pid != current_pid AND sessions.pid alive(or same-uid EPERM)** → **6.3c SID_COLLISION 분기**(fail-closed). live foreign lease 침해 절대 금지. 사용자가 `eghs-migrate` 또는 세션 종료 후 재시도.

               **stale-cleanup 절차 (4번 분기에만 도달)**:
                  **precondition validation** (destructive 절차 진입 전 필수):
                     * `sessions/<sid>.json` 잔존 시 body를 read해 `prior_start_ms`를 파싱한다(이 시점에 unlink는 아직 하지 않는다). `prior_start_ms` **부재/parse 실패/음수/> `2^53-1`/> `now_ms + far_future_grace_ms`**(기본 `far_future_grace_ms=86400000` = 24h) 중 하나라도 해당하면 **corrupt lease 판정 → 후보 `INFRA_NOT_READY`로 즉시 반환**(#4 매트릭스 적용, marker `reason=lease_unavailable`). 이 경우 **lease/cascade unlink 절대 금지** — 손상된 sid에 대해 sid-scoped marker를 만들면 lease가 이미 없어 GC 경로가 사라지므로 orphan 영구화 위험. **remediation: `eghs-migrate --clear-sid <SID>`** 실행(R2.5 정의 참조). 일반 `eghs-migrate`/`eghs-init --repair`는 활성 lease 존재 sid를 건드리지 않으므로 자동 회복 불가 — `--clear-sid`가 유일 escape hatch.
                     * sessions 부재 case(lease 자체가 없어 `prior_start_ms` 개념 없음)는 이 검사 skip → `start_ms = now_ms`로 lease 신규 생성.
                  precondition 통과 후 아래 i, iii–vi 실행 (ii는 reserved skip-note, 아래 참조):
                  i. cascade delete 먼저(lease 유지 상태에서 — #5b GC 원칙과 동일): `baselines/<sid>.txt` unlink + `verify-logs/<sid>/` **재귀 삭제**(rm -rf semantics: entries 먼저 unlink 후 rmdir) + `debug/<sid>.jsonl` unlink + `pre/<sid>/` **재귀 삭제** + `failed/<sid>/` **재귀 삭제** + `locks/stop-<sid>.lock` unlink + `locks/stop-<sid>.recover.lock` unlink + **failed/<sha1(*)>.json key-scoped marker 중 origin_sid == 현 sid인 것** unlink(전체 `failed/` scan). 모두 best-effort.
                  ii. **[reserved skip-note; DO NOT IMPLEMENT]**: R16 senior#2 fix로 sanity validation이 precondition으로 hoist되어 이 자리는 no-op. 번호 유지 이유는 후속 iii-vi의 기존 문서 참조 안정성 보존.
                  iii. **`start_ms` 결정**:
                     * **sessions 부재였던 case (prior_start_ms 없음)**: cascade 결과와 무관하게 항상 `start_ms = now_ms`. 이 case에는 fallback clamp 공식 적용 불가(prior_start_ms 없음).
                     * **sessions 존재 case, cascade 모두 성공 또는 ENOENT만 발생**: `start_ms = prior_start_ms`.
                     * **sessions 존재 case, EPERM/EACCES 등 진짜 실패 1건이라도 발생**: key-scoped foreign marker 잔존 가능성. fallback `start_ms = max(now_ms, prior_start_ms + 1)` 사용(clock skew clamp). debug log에 `event: "eperm_start_ms_fallback"` + `{prior_start_ms, now_ms, chosen_start_ms}` 1줄 기록.
                  iv. **stale lease unlink**: 이 시점에 `sessions/<sid>.json` unlink(precondition + cascade 완료 후 안전). ENOENT면 이미 GC됨(계속 진행).
                  v. **lease 재작성**: **normal create branch(#6.3.1)와 동일한 link(2) exclusive 절차 사용** (atomic-write contract §R2.5 준수, 직접 create 금지 — concurrent reader가 empty/partial JSON 관측 방지): body `{schema_version, pid: current claude-code-pid, uid, start_ms: <iii 분기 결정>, renewed_ms: now_ms}`를 `sessions/tmp/<sid>.<pid>.<seq>`에 fsync 후 `link(2)`로 `sessions/<sid>.json`에 이동. EEXIST면 다른 hook이 동시 재생성 → tmp unlink → 그 lease body의 pid를 stat → current_pid와 일치하면 renew 분기, 다른 pid alive(or same-uid EPERM)면 SID_COLLISION, 다른 pid dead면 본 b 재진입(1회 retry, 그래도 실패 시 후보 `INFRA_NOT_READY` → #4 매트릭스).
                  vi. **#6.3a baseline 작성**(link(2) exclusive) 1회 재시도. 실패 시 후보 `INFRA_NOT_READY` → #4 매트릭스.
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
       * **INVALID**: state write skip + **sid-scoped failed marker** `failed/<sid>/<sha1(key)>.json` (reason=`schema_invalid`) 기록 (R4 매트릭스와 일관, INVALID never fail-OPEN 원칙 적용). marker write 자체가 ENOENT/EPERM이면 best-effort skip. `pre/<sid>/<sha1(key)>.<tool_use_id>.write.json`도 unlink. INVALID 해소(`eghs-init --repair`) 후 첫 PreToolUse가 `STATE_RECORD_FAILED`로 정확한 root cause 차단.
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

**Dry-run 모드 (normative)**:

* MVP §8.7의 CLI interface(`<hook-script> --dry-run < input.json`)는 R6 precedence chain 실행 방식을 다음과 같이 변형한다:
    * `--dry-run` 플래그 감지 시 **precedence #1~#3.5은 그대로 실행**(stat-only + NO_SESSION strict validation 포함, mutation 없음). **#3.7 처리**: `disk_schema == null` 이면 #3.7 step 0 fast-path와 동일하게 **tombstone stat + guard.lock 모두 skip**(would_write 미기록, 실제 hook 동작과 정확히 일치). `disk_schema != null` 이면 **tombstone stat은 그대로 수행**(stat mutation 아님), 그러나 **guard.lock create + flock 는 suppress** — 대신 "성공했다고 가정"하고 guard.lock 경로를 `would_write`에 기록. tombstone 존재 시 정상 실행처럼 `sid_cleared` 반환(dry-run 결정에 반영). state mutation 단계(#4 migrate.lock stale unlink, #5 recover.lock/sessions/verify-logs GC, #6 lease/baseline write, #7의 marker write) **전체 suppress**.
    * 결정 계산은 실제 실행과 동일 규칙 적용: mutation을 "성공했다고 가정"하고 후속 로직 진행(e.g., #6 lease write가 실제로는 안 이루어졌지만 결정 로직은 lease 있는 것처럼 계속).
    * 후속 hook 호출을 위한 `pre/<sid>/<sha1(key)>.<tool_use_id>.write.json`도 dry-run에서는 생성 안 함(mutation 금지).
    * 출력: 결정 JSON(`{decision, deny_code?, reason?, would_write: [<path>, ...]}`)을 stdout에 1줄로 출력. `would_write`는 dry-run이 아니었다면 mutation했을 파일 경로 리스트(debug/diagnostic 용도).
    * exit code: 실제 실행 시 exit code와 동일(0=allow, non-zero=block). stderr에는 어떤 mutation도 시도 안 했음을 명시(`[eghs] dry-run: no state writes performed`).
* dry-run은 kill switch/CI passthrough 검사도 그대로 통과시킨다(#2/#3 발동 시 정상 실행과 동일하게 exit 0). 이는 CI 파이프라인에서 configuration 검증 용도.

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
| Kill switch usage           | 주당 kill switch 발동 횟수                                                                              | < 1회   | ~~Yes~~ → **No** (2026-08-17 개정, 아래) |

`Gate enforcement rate`는 hook 코드 자체의 invariant(allow ⇒ evidence 있음)이므로 unit test로 보장하며, runtime metric에서는 제거.

**개정 (2026-08-17, P5)**: `Kill switch usage`의 `MVP measurable`은 **No**로 정정한다. §R6 #2는 kill switch가 active일 때 stderr 1줄 외 **어떤 disk write도 금지**하며, 이 no-write 규칙이 G5("즉시 비활성화 가능")와 "kill switch 환경에서 disk leak 없음" 보장의 단일 근거다. 따라서 kill switch 발동은 `debug/<sid>.jsonl`에 기록될 수 없고(기록하는 순간 invariant 위반), 이벤트 schema의 `kill_switch` 필드는 실제로는 항상 `off`이며 `decision: "kill_switch"` 행 역시 hook에서 생성되지 않는다. 발동 횟수는 hook telemetry가 아니라 운영자(human)가 out-of-band로 센다 — kill switch는 §3 non-goal에 따라 human intent 전용이기 때문이다. `eghs-metrics`는 셀 수 없는 횟수 대신 **현재 kill switch 상태**(`off|file|env|ci`)를 보고한다. 같은 성격의 선례: `False-deny rate`(not-measured).

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
* **`gate_applicable`은 §R3의 gate 적용 대상 판정과 정확히 일치한다** — `state_gate_paths` 매칭 **AND 디스크에 파일 존재**. 신규 파일 Write(§R3 "파일이 존재하지 않으면 신규 파일 Write 후보")는 `gate_applicable: false`로 기록한다. (2026-08-17 P5 명문화: `true`로 기록하면 신규 파일이 `has_gate_passing_state: false`인 채 Evidence-bearing Edit ratio 분모에 영구히 남아 metric을 왜곡한다.)
* `Evidence-bearing Edit ratio`/`Gate deny ratio`는 위 schema의 필드만으로 계산 가능.
* `Bash-bypass detection rate`: 일정 주기로 watched paths의 SHA를 polling해 변경을 감지한 직후의 Edit gate 결과를 측정. polling은 별도 background script(`eghs-bypass-watcher`)로 옵션 제공.
    * (2026-08-17 P5) 관측 로그는 `debug/bypass-watcher.jsonl`(1줄 1 `bypass_observed` 이벤트: `ts_ms`/`path`(canonical key)/`prev_sha`/`new_sha`), 직전 poll 스냅샷은 `debug/.bypass-snapshot.json`. 기존 subdir만 사용하므로 §R2.5 레이아웃 변경도 `schema_version` bump도 없다. `debug/` GC는 sid 단위(`debug/<sid>.jsonl`)라 이 두 파일에 닿지 않으므로 watcher가 스스로 로그를 rotate한다(§G5).
    * **attribution**: 변경된 파일의 `reads/<sha1(key)>.json`이 **새 sha**를 `evidence: post_edit_success`로 담고 있으면 EGHS가 관측한 편집이므로 bypass가 아니다. `full_read`는 attribution이 되지 않는다(읽기는 파일을 바꾸지 않는다).
    * **생성/삭제는 관측 대상이 아니다**: EGHS가 본 적 없는 신규 파일에 대한 후속 Edit은 `UNREAD_OR_STALE`로 deny되지 `RACE_DETECTED`가 아니므로 본 metric의 정의 범위 밖이다(스냅샷에만 반영).
    * **분류**: 관측 직후 같은 path의 **가장 이른** PreToolUse Write/Edit/MultiEdit 결정을 본다. `block`+`RACE_DETECTED` = detected, 다른 deny_code의 `block` = `blocked_other`(편집은 막혔으나 race 탐지는 아님), `allow` = missed, 후속 호출 자체가 없으면 `undetermined`(분모 제외 — 일어나지 않은 Edit은 deny될 수 없다). 비율 = `detected / (detected + blocked_other + missed)`로 §5 정의(`RACE_DETECTED`로 deny된 비율)를 그대로 유지하되, `blocked_other`를 별도 보고해 "막혔는데 놓친 것으로 읽히는" 오독을 막는다.
* `Stop verification pass rate` = `count(Stop, decision=allow, kill_switch=off) / count(Stop, kill_switch=off)`.
* False-deny rate는 `eghs-label` CLI(post-MVP)로 사람이 deny 이벤트에 `false_positive: bool` annotation을 추가. **MVP에서는 not-measured로 명시**.
* (2026-08-17 P5) 위 metric들의 실제 계산은 `eghs-metrics` CLI(`node hooks/metrics.js`)가 수행한다 — `debug/` 로그만 읽는 read-only 도구이며 lock도 sid도 요구하지 않는다. 분모가 0인 비율은 `0`이 아니라 `null`로 보고한다("데이터 없음"과 "하나도 통과 못함"은 §6 exit criteria에서 다른 판정이다).

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

**P5 "matcher 확장"의 범위 (2026-08-17 확정)**: 여기서 matcher는 **`state_gate_paths` glob matcher**를 가리키며, Claude Code hook 등록의 `matcher` 필드(`Read|Write|Edit|MultiEdit`)가 아니다. 위 표의 Scope 열은 모든 행에서 *경로* 범위이고(P4 "핵심 source path만" → P5 "source/config 전체"), tool 추가(NotebookEdit/Bash)는 §R3 스펙 변경이며 Bash 직접 차단은 §3 non-goal이다. P5는 gate 대상 경로를 저장소의 source+config 전면으로 넓히고, 위 exit criteria를 **측정 가능하게** 만드는 단계다(`eghs-metrics` + `eghs-bypass-watcher`, §5 참조). docs(`*.md`)는 source도 config도 아니므로 대상 밖.

**P5 검증 도구**: `eghs-metrics` CLI(`node hooks/metrics.js`)가 §5 metric 표를 계산하고, `eghs-bypass-watcher`(`node hooks/bypass-watcher.js`)가 Bash-bypass 관측을 공급한다.

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
    * stderr: block 시 `[eghs] block <deny_code>: <reason> sid=<sid>` + check별 상세 라인(exit 2에서 Claude Code가 모델에 전달하는 유일한 채널), 그 외 자유 형식 디버그 메시지. 구조화 결정 기록은 `debug/` 로그가 담당. `sid` 값이 없는 case(NO_SESSION deny 등)에서는 `sid=none`으로 표기(user가 `--clear-sid`용 SID 복사 가능한지 판단 가능). corrupt-lease/baseline case(`reason=lease_unavailable`)에서는 stderr 마지막에 `run: eghs-migrate --clear-sid <sid> [--force]` 안내를 추가한다.
8. shellcheck 통과(Bash 구현 시) 또는 `tsc --noEmit` + `eslint` 통과(Node 구현 시). 구현 언어는 config 외 hook 코드 단위로 통일.
9. `state_gate_paths`는 bash-glob(picomatch v4, `{ dot: true }`)으로 명세된다. gitignore(5) 시맨틱이 아니다 — 중첩 매칭은 `**/` 접두 필수, trailing `/` 디렉토리 한정 미지원 (§R4 매칭 문법 참조).
10. canonical path는 case-aware `realpath`(R2 참조), SHA는 디스크 raw bytes의 SHA-256으로 통일된다. case-sensitivity는 `eghs-init`이 1회 probe해 `fs-info.json`에 캐시한다.
11. atomic state write는 **destination-local** `tmp/` 임시 파일 + `fsync(fd)` + same-dir `rename(2)` + `fsync(dirfd)` 절차를 따르며, 임시 파일명 suffix는 per-write 단조 카운터.
12. cross-session 정책: `reads/` 공유, gate는 `sid` 일치 요구.
13. `pre/<sid>/`, `failed/`, `locks/`, `verify-logs/`, `reads/`, `reads/tmp/`, `failed/tmp/`, `sessions/`, `baselines/` 디렉토리의 GC/lifecycle 정책이 구현된다. `reads/`는 TTL + sid liveness 기반 GC, `sessions/`는 TTL + pid/uid liveness 기반 GC.
14. `eghs-init` CLI가 부트스트랩(schema_version 파일, fs-info.json 생성 — `flock_ok`, `fs_st_dev`, `fs_statfs_id` 포함 flock capability probe 수행)을 수행하고, `eghs-migrate` CLI가 schema upgrade를 처리한다(자동 삭제 금지). `eghs-migrate`는 `sessions/` 및 `locks/`(admin-mutex.guard 제외)가 비어 있을 때만 동작한다. **`eghs-init --repair`는 R2.5 §293-297의 네 케이스(INVALID schema / subdir 부분 부재 / fs-info.json 부재 / fs-info.json unhealthy: flock_ok≠true, corrupt JSON, 필수 필드 누락, FS anchor 불일치) 모두를 idempotent하게 회복해야 한다**(FS_INFO_MISSING, subdir-missing 형 INFRA_NOT_READY, legacy-cache, FS 이동 등 self-heal 경로가 없으면 사용자가 무한 loop에 빠짐; MVP 필수).
15. Stop hook의 `verification_parallel` 기본값은 true이며, 단일 명령 timeout 기본값 45초로 p95 90s budget을 충족한다.
16. Kill switch는 SCHEMA_MISMATCH보다 우선 평가되고, CI passthrough는 Stop hook을 제외한 hook에만 적용된다.
17. PostToolUse가 `pre/<posttool_sid>/<sha1(key)>.<tool_use_id>.write.json`을 로드하지 못하면 `STATE_RECORD_FAILED` failed marker를 남긴다. `pretool_sid == posttool_sid` invariant가 깨지면 동일 처리.
18. failed marker는 `origin_sid` + `ts_ms`로 tagged되며, 다른 세션의 marker는 현 세션 `sessions/<sid>.json`의 immutable `start_ms` 이전이어야 자동 해제된다. key-scoped와 sid-scoped marker 두 가지 경로를 모두 처리하며 sid-scoped는 cascade GC된다.
