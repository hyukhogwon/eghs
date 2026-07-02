'use strict';

// Model-facing working agreement (PRD §R1). English on purpose: the model reads
// this as instruction. Injected via UserPromptSubmit as additionalContext.
const DISCIPLINE_PRINCIPLES = [
  '[EGHS] Working agreement for this session:',
  '- Before modifying an existing file, Read it first.',
  '- If a file changed out-of-band (e.g. via Bash), Read it again before editing.',
  '- Before ending your turn, ensure the configured verification (typecheck/lint/tests) passes.',
].join('\n');

// Fail-soft nudge when EGHS state is not initialized (PRD §R6 UserPromptSubmit row).
const INIT_GUIDANCE =
  '[EGHS] state not initialized — run `node hooks/init.js` to enable verification gating.';

// hookSpecificOutput envelope; Claude Code injects additionalContext as a system
// reminder on exit 0 (verified 2026-07-02).
function buildAdditionalContext(text) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}

module.exports = { DISCIPLINE_PRINCIPLES, INIT_GUIDANCE, buildAdditionalContext };
