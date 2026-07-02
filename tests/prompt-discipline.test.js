'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISCIPLINE_PRINCIPLES,
  INIT_GUIDANCE,
  buildAdditionalContext,
} = require('../hooks/lib/prompt-discipline');

test('DISCIPLINE_PRINCIPLES states all three R1 rules', () => {
  assert.match(DISCIPLINE_PRINCIPLES, /Read it first/);
  assert.match(DISCIPLINE_PRINCIPLES, /out-of-band/);
  assert.match(DISCIPLINE_PRINCIPLES, /verification/);
});

test('INIT_GUIDANCE points at the init command', () => {
  assert.match(INIT_GUIDANCE, /hooks\/init\.js/);
});

test('buildAdditionalContext wraps text in the UserPromptSubmit envelope', () => {
  const parsed = JSON.parse(buildAdditionalContext('hello'));
  assert.deepEqual(parsed, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'hello',
    },
  });
});

test('buildAdditionalContext round-trips multi-line principle text intact', () => {
  const parsed = JSON.parse(buildAdditionalContext(DISCIPLINE_PRINCIPLES));
  assert.equal(parsed.hookSpecificOutput.additionalContext, DISCIPLINE_PRINCIPLES);
});
