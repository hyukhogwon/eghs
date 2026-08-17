# EGHS P5 — matcher expansion + measurement (plan)

PRD §6 rollout row:

| Phase | Enabled Hooks | Scope | Exit Criteria |
|-------|---------------|-------|---------------|
| P5 | matcher 확장 | source/config 전체 | Bash-bypass detection > 90%, kill switch < 주 1회 |

P4 shipped the gate against a single glob (`hooks/**/*.js`). P5 widens that
matcher to the repo's whole source/config surface and — this is the larger
half — makes the exit criteria *checkable*. Today none of PRD §5's metrics can
actually be computed: the debug JSONL is written, but nothing reads it, and
the `eghs-bypass-watcher` named in §5 does not exist.

## Assumptions (stated because the PRD is thin here)

1. **"matcher 확장" means the `state_gate_paths` glob matcher, not the Claude
   Code hook `matcher` field.** §6's Scope column is a *path* scope for every
   row ("핵심 source path만" → "source/config 전체"). The tool matcher stays
   `Read|Write|Edit|MultiEdit`; adding tools (NotebookEdit, Bash) would be a
   §R3 spec change, and §3 lists direct Bash blocking as a non-goal.
2. **`eghs-metrics` is a new CLI.** §5 asserts the metrics are computable from
   `debug/<sid>.jsonl` but names no CLI for computing them. Without one, P4's
   own exit criterion (evidence-bearing Edit ratio > 0.9) was never checkable
   either. It joins the `eghs-init`/`eghs-migrate`/`eghs-inspect` family.
3. **Kill-switch usage is not measurable from hook telemetry** and the PRD is
   self-contradictory here (§887 says "MVP measurable? Yes"; §677 forbids any
   disk write under the kill switch, and §R6's mutation-free invariant is the
   single basis for G5). The invariant wins — this is a PRD amendment, not an
   implementation gap. Same resolution the repo already used for False-deny
   rate.

## Unit 1 — `gate_applicable` fidelity on the new-file Write row

`hooks/pre-tool-use.js` `handleWriteGate` logs `gateApplicable: true` for both
branches of `gate.allow`, including the new-file Write (`gate.newFile`). PRD
§R3 line 443-444 defines gate applicability as "matches `state_gate_paths`
**and the file exists on disk**"; a missing file is explicitly "신규 파일
Write 후보", classified entirely by R4.

Consequence today: every new file created under a gated glob lands in the
Evidence-bearing Edit ratio *denominator* with `has_gate_passing_state:false`,
permanently depressing the metric P4/P5 gate on. Fix before building the
reader, or the first number the CLI prints is wrong.

- `gateApplicable: !gate.newFile` on the allow row.
- Test: new-file Write under a gated glob logs `gate_applicable:false`,
  existing-file allow still logs `true`, deny row unchanged.
- Verify: `node --test tests/pre-tool-use.test.js`.

## Unit 2 — `eghs-metrics` CLI (`hooks/metrics.js`)

Read-only. Never writes. Parses `debug/*.jsonl` (skipping unparseable lines —
a truncated tail from a killed hook must not abort the report).

```
node hooks/metrics.js               # human table
node hooks/metrics.js --json        # machine output
node hooks/metrics.js --sid <SID>   # one session
node hooks/metrics.js --since 7d    # 7d / 24h / <ISO-8601> window on ts_ms
```

Metrics (PRD §5 definitions verbatim):

| key | numerator / denominator |
|-----|-------------------------|
| `evidence_bearing_edit_ratio` | `hook=PreToolUse, tool∈{Write,Edit,MultiEdit}, gate_applicable, decision=allow, has_gate_passing_state` / `hook=PreToolUse, tool∈{W,E,ME}, gate_applicable` |
| `gate_deny_ratio` | `decision=block, gate_applicable` / `gate_applicable` |
| `stop_verification_pass_rate` | `hook=Stop, decision=allow, kill_switch=off` / `hook=Stop, kill_switch=off` |
| `stop_latency_ms` | p50/p95 of `latency_ms` where `hook=Stop` |
| `kill_switch_usage` | `null` + `reason: "not measurable — §R6 kill switch performs no disk write (G5)"`; the report prints the *current* kill-switch state instead |
| `bypass_detection_rate` | unit 4 |

A ratio with a zero denominator is `null`, never `0` and never NaN — "no data"
and "nothing passed" are different answers and the exit criteria treat them
differently. Every ratio row carries its raw `n`/`d` counts.

Percentiles: nearest-rank on the sorted sample (`ceil(p × n)`), no
interpolation — the sample is tens of events, not thousands.

- Tests: `tests/metrics.test.js` — fixture debug dirs, each ratio incl. its
  zero-denominator row, `--sid` / `--since` filtering, malformed-line
  tolerance, `--json` shape.

## Unit 3 — `eghs-bypass-watcher` (`hooks/bypass-watcher.js`)

PRD §916: "일정 주기로 watched paths의 SHA를 polling해 변경을 감지 […]
polling은 별도 background script(`eghs-bypass-watcher`)로 옵션 제공."

```
node hooks/bypass-watcher.js --once
node hooks/bypass-watcher.js --interval-seconds 30
```

Walks the repo for files matching `state_gate_paths` (same picomatch call as
`gate.js` — one matcher implementation, per §R3 "picomatch 단일 reference"),
SHA-256s each, and diffs against the previous poll.

A changed file is **attributed** (an EGHS-observed edit, not a bypass) iff
`reads/<sha1(key)>.json` records the *new* SHA with evidence
`post_edit_success`. Anything else — the model shelling out to `sed`, another
process, a `git checkout` — is an unattributed change and is what §5 means by
a Bash bypass.

Writes one JSONL line per unattributed change to
`debug/bypass-watcher.jsonl`:

```json
{"schema_version":1,"ts_ms":…,"event":"bypass_observed","path":"<canonical key>","prev_sha":"…","new_sha":"…"}
```

- `debug/` is an existing state subdir, so no layout change and no
  `schema_version` bump. Its GC is per-sid (`debug/<sid>.jsonl`), so this file
  is never swept — the watcher rotates it itself at 5 MiB to `.1` (keep 1),
  since an unbounded log is the §G5 disk-leak failure this project already
  fixed twice.
- Snapshot of the last poll lives in `debug/.bypass-snapshot.json` (atomic
  write). A missing/corrupt snapshot means "first poll" — record the baseline,
  emit nothing.
- Kill switch is honoured (`.claude/eghs-off` / `EGHS_DISABLED=1`) → one stderr
  line, exit 0, zero writes. Same G5 rule the hooks follow.
- Requires a healthy `schema_version`; otherwise abort with the `eghs-init`
  remediation line, matching `inspect.js`.
- Not a hook: no lease, no guard, no precedence chain. It only reads `reads/`
  and appends to its own log.
- Tests: `tests/bypass-watcher.test.js` — first poll is baseline-only,
  unattributed change emits, `post_edit_success`-attributed change does not,
  kill switch writes nothing, rotation at threshold, corrupt snapshot recovery.

## Unit 4 — bypass detection rate in `eghs-metrics`

Correlation, computed in `metrics.js` from the two logs:

For each `bypass_observed{path K, ts T}`, find the earliest PreToolUse
write-decision event on path K with `ts_ms > T` across all `debug/<sid>.jsonl`:

- no such event → **undetermined** (the bypass was never followed by an edit
  attempt; excluded from the denominator, reported separately as
  `undetermined`).
- `decision=block` and `deny_code=RACE_DETECTED` → **detected**.
- anything else → **missed**.

`bypass_detection_rate = detected / (detected + missed)`.

Excluding undetermined events from the denominator is the honest reading of
§5's definition ("Bash로 파일이 변경된 직후 **같은 파일의 Edit 호출이**
`RACE_DETECTED`로 deny된 비율") — an edit call that never happened cannot be
denied. The count is surfaced so the ratio is never read as fuller coverage
than it has.

- Tests extend `tests/metrics.test.js`: detected / missed / undetermined rows,
  the zero-denominator case, and interleaving across two sids.

## Unit 5 — rollout + docs

1. Widen `.claude/eghs.config.json`:
   `["hooks/**/*.js", "tests/**/*.js", "package.json", ".claude/*.json"]`
   — source and config, per §6's Scope column. Docs (`*.md`) stay out; they are
   neither source nor config, and gating them buys nothing.
2. PRD amendments (append to §5, in the established amendment style):
   - `Kill switch usage` → MVP measurable **No**, with the G5 rationale.
   - `gate_applicable` is false for new-file Writes (unit 1), stated where the
     event schema is defined.
   - name `eghs-metrics` alongside `eghs-bypass-watcher` in 측정 방법.
3. README (Korean): metrics + watcher CLI section.
4. HANDOFF: P5 row, P5 design decisions, admin CLI list.
5. Whole-branch self-review pass; `npm test` green; live smokes:
   `node hooks/metrics.js` on this repo's real debug log, and
   `node hooks/bypass-watcher.js --once` twice with a `sed`-in-between.

## Verification

Per unit: `node --test tests/<file>.test.js`, then `npm test` (bare
`node --test tests/` is broken on Node v24 — see HANDOFF).
Suite is 427 at P4 finale; each unit only adds.
