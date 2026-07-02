'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCI } = require('../hooks/lib/ci');

test('isCI is false for an empty env', () => {
  assert.equal(isCI({}), false);
});

test('isCI is true for CI=true and CI=1', () => {
  assert.equal(isCI({ CI: 'true' }), true);
  assert.equal(isCI({ CI: '1' }), true);
});

test('isCI is false for CI=false or CI=0 (not a truthy CI marker)', () => {
  assert.equal(isCI({ CI: 'false' }), false);
  assert.equal(isCI({ CI: '0' }), false);
});

test('isCI is true for each vendor flag set to "true"', () => {
  assert.equal(isCI({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isCI({ GITLAB_CI: 'true' }), true);
  assert.equal(isCI({ BUILDKITE: 'true' }), true);
});
