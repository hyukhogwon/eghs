# EGHS

Evidence-Gated Hook System for Claude Code. See `PRD.md` for the full spec.

에이전트가 **읽지 않은 파일을 고치는 것**을 시스템이 막는다. 편집 직전에 같은 세션의
읽기 증거(evidence)가 있는지 확인하고, 없으면 편집을 거부한다. 사람의 주의력이 아니라
파일시스템 상태로 강제한다.

구현 완료:

| Phase | 내용 |
|-------|------|
| P1 | **Stop hook** — typecheck/lint/test 검증 게이트 |
| P2 | **UserPromptSubmit** — fail-soft 프롬프트 규율 주입 |
| P3 | **Read/Edit state writer** — canonical path SHA-256 증거 기록, TOCTOU/부분적용 감지, failed marker |
| P4 | **Edit state gate** — 증거 없는 편집을 exit 2로 차단 + `eghs-migrate` 관리 CLI |
| P5 | **matcher 확장 + 계측** — gate 대상을 source/config 전면으로 확대, `eghs-metrics` / `eghs-bypass-watcher` |

## Setup

```bash
npm install
node hooks/init.js
```

`.claude/eghs.config.json`에서 설정한다:

```json
{
  "verification_commands": { "typecheck": "pnpm typecheck", "lint": "pnpm lint" },
  "state_gate_paths": ["src/**/*.ts"]
}
```

- `verification_commands` — Stop hook이 실행할 검증 명령.
- `state_gate_paths` — **게이트를 적용할 경로**. 기본값 `[]`(게이트 꺼짐). bash-glob
  (picomatch v4, `{dot:true}`) 문법이며 repo 루트 기준 상대 경로에 매칭한다. 중첩 경로는
  `**/`가 필요하고, gitignore 문법이 아니다.

All hooks (Stop, UserPromptSubmit, PreToolUse/PostToolUse for Read/Write/Edit/MultiEdit)
are registered in `.claude/settings.json`. Make sure `.claude/state/` is
gitignored (state includes session leases, locks, evidence records, and verification logs, not source).

## 게이트 동작

`state_gate_paths`에 매칭되는 **기존 파일**을 Write/Edit/MultiEdit로 고치려 하면,
다음을 모두 만족해야 통과한다:

1. `full_read` 또는 `post_edit_success` 증거 기록이 있고,
2. 그 기록의 sid가 **현재 세션**과 같고 (다른 세션의 읽기는 증거가 되지 않는다),
3. 기록된 SHA-256이 디스크 현재 내용과 일치하고 (그 사이 바뀌었으면 재읽기 필요),
4. 기록이 `stale_after_seconds`(기본 1800초) 이내이며,
5. 해당 파일에 failed marker가 없어야 한다.

거부되면 exit 2 + stderr `[eghs] block <deny_code>: <reason> sid=<sid>`. 대부분의 해법은
"그 파일을 먼저 Read". 새 파일 생성은 게이트 대상이 아니다.

편집 없이 판정만 미리 보려면:

```bash
printf '{"session_id":"<sid>","tool_name":"Edit","tool_input":{"file_path":"'$PWD'/src/a.ts"}}' \
  | node hooks/pre-tool-use.js --dry-run
# {"decision":"block","deny_code":"UNREAD_OR_STALE","would_write":[...]}
```

모든 hook이 `--dry-run`을 받으며, 이 모드는 **state를 전혀 쓰지 않는다**.

## 상태 점검 / 관리 CLI

```bash
node hooks/inspect.js                   # state dir 전체를 JSON으로 덤프
node hooks/init.js --repair             # 손상된 schema_version / 누락 subdir / fs-info 재탐침

node hooks/migrate.js                   # schema 이행: 세션 GC → 정지 상태 확인 → 레코드 정리 → atomic bump
node hooks/migrate.js --dry-run         # 아무것도 쓰지 않고 계획만 출력
node hooks/migrate.js --clear-sid <SID> # 손상된 lease/baseline 탈출구
node hooks/migrate.js --clear-migrate-lock
node hooks/migrate.js --clear-init-lock
```

hook이 `INFRA_NOT_READY`를 반복 반환하면 stderr의 remediation 줄이 위 명령 중 하나를
지목한다. `--clear-sid`는 살아있는 세션을 지우지 않으며(uid/pid 게이트), 강제하려면
`--force`, 다른 사용자 소유면 `--force-foreign-cleanup`이 필요하다.

## 계측 (PRD §5)

모든 hook은 결정 1건당 1줄을 `.claude/state/eghs/debug/<sid>.jsonl`에 남긴다
(`debug: false` config로만 끌 수 있다). 그 로그를 읽어 성공 지표를 계산한다:

```bash
node hooks/metrics.js              # 지표 표
node hooks/metrics.js --json       # 기계 판독용
node hooks/metrics.js --sid <SID>  # 한 세션만
node hooks/metrics.js --since 7d   # 7d / 24h / 30m / ISO-8601 구간
```

분모가 0인 비율은 `0`이 아니라 `n/a`로 나온다 — "데이터 없음"과 "하나도 통과 못함"은
다른 판정이기 때문이다.

`Bash-bypass detection rate`는 폴링 워처가 있어야 측정된다. Bash·외부 프로세스가
게이트 대상 파일을 바꾼 것을 감지해 기록하고, `eghs-metrics`가 그 직후의 Edit 판정과
대조한다(`RACE_DETECTED`면 detected):

```bash
node hooks/bypass-watcher.js --once                  # 1회 폴링
node hooks/bypass-watcher.js --interval-seconds 30   # 백그라운드 상주
```

첫 폴링은 baseline만 잡고 아무것도 보고하지 않는다. 변경이 `post_edit_success` 증거로
설명되면(= EGHS가 본 편집) bypass가 아니다. 파일 생성·삭제는 스냅샷에만 반영한다 —
EGHS가 본 적 없는 파일의 후속 Edit은 `UNREAD_OR_STALE`로 막히지 `RACE_DETECTED`가
아니라서 이 지표의 정의 범위 밖이다.

kill switch 발동 횟수는 **측정하지 않는다**. kill switch가 켜지면 hook은 디스크에
아무것도 쓰지 않고(그 no-write 규칙이 즉시 비활성화 보장의 근거다), 따라서 남길 로그가
없다. `eghs-metrics`는 대신 현재 kill switch 상태를 보고한다.

## Kill switch

- `.claude/eghs-off` (create an empty file), or
- `EGHS_DISABLED=1`

둘 중 하나면 모든 hook이 즉시 exit 0으로 통과한다(state 변경 없음).

## Tests

```bash
npm test
```
