'use strict';

// UUIDv4 shape for Claude Code session ids. Docs only guarantee session_id
// is a string; anything else lands on the NO_SESSION fail-open path, which
// every entrypoint must keep observable on stderr. Extracted once the third
// consumer (P3 tool hooks) landed — previously local to hooks/stop.js.
const SID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isValidSid(sid) {
  return typeof sid === 'string' && SID_REGEX.test(sid);
}

module.exports = { SID_REGEX, isValidSid };
