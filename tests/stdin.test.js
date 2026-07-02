'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'hooks', 'lib', 'stdin.js');

// readStdin is a synchronous whole-stream drain; exercise it through a real
// child process so the pipe semantics (chunking, EOF) match hook invocation.
function runReadStdin(input) {
  const r = spawnSync(
    'node',
    ['-e', `const {readStdin}=require(${JSON.stringify(LIB)});const s=readStdin();process.stdout.write(String(s.length)+':'+s.slice(0,32)+':'+s.slice(-32));`],
    { input, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('readStdin returns the full piped input', () => {
  assert.equal(runReadStdin('{"session_id":"abc"}'), '20:{"session_id":"abc"}:{"session_id":"abc"}');
});

test('readStdin returns an empty string for empty stdin', () => {
  assert.equal(runReadStdin(''), '0::');
});

test('readStdin drains input larger than one 64KiB buffer', () => {
  const big = 'x'.repeat(65536 * 2 + 123) + 'END';
  const out = runReadStdin(big);
  assert.equal(out, `${big.length}:${'x'.repeat(32)}:${'x'.repeat(29)}END`);
});

// Pins the EAGAIN retry path — the one behavioral change vs the pre-extraction
// code. Touching process.stdin flips fd 0 to O_NONBLOCK, so readSync hits
// EAGAIN until the parent writes 150ms later. The CPU bound distinguishes the
// 5ms sleep from a busy-loop (which would burn ~150ms of CPU here).
test('readStdin retries through EAGAIN on a non-blocking stdin without spinning', async () => {
  const script =
    'process.stdin;' +
    `const {readStdin}=require(${JSON.stringify(LIB)});` +
    'const s=readStdin();' +
    'const cpu=process.cpuUsage();' +
    "process.stdout.write('got:'+s+':cpuMs:'+Math.round((cpu.user+cpu.system)/1000));";
  const child = spawn('node', ['-e', script]);
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (errOut += d));
  setTimeout(() => {
    child.stdin.write('hello');
    child.stdin.end();
  }, 150);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, errOut);
  const m = out.match(/^got:hello:cpuMs:(\d+)$/);
  assert.ok(m, `unexpected child output: ${out}`);
  assert.ok(Number(m[1]) < 100, `EAGAIN wait burned ${m[1]}ms CPU — busy-looping instead of sleeping`);
});
