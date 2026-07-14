'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { flockShNb, flockExNb, flockUn, acquireExWithTimeout } = require('../hooks/lib/flock');
const { sleepMs } = require('../hooks/lib/stdin');

const FLOCK_LIB = path.join(__dirname, '..', 'hooks', 'lib', 'flock.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-flock-'));
}

function openLock(dir) {
  return fs.openSync(path.join(dir, 'guard.lock'), 'w', 0o600);
}

// Runs a snippet in a child process (flock is per-open-file-description, so
// same-process fds can't exercise contention) and returns its stdout.
function inChild(dir, snippet) {
  const script = `
    const fs = require('fs');
    const { flockShNb, flockExNb, flockUn } = require(${JSON.stringify(FLOCK_LIB)});
    const fd = fs.openSync(${JSON.stringify(path.join(dir, 'guard.lock'))}, 'r');
    ${snippet}
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('flockShNb acquires a free lock', () => {
  const fd = openLock(mkTmpDir());
  assert.deepEqual(flockShNb(fd), { ok: true, wouldBlock: false });
  fs.closeSync(fd);
});

test('concurrent shared holders both succeed', () => {
  const dir = mkTmpDir();
  const fd = openLock(dir);
  assert.equal(flockShNb(fd).ok, true);
  assert.equal(inChild(dir, `process.stdout.write(JSON.stringify(flockShNb(fd)));`), '{"ok":true,"wouldBlock":false}');
  fs.closeSync(fd);
});

test('exclusive attempt against a held shared lock reports wouldBlock', () => {
  const dir = mkTmpDir();
  const fd = openLock(dir);
  assert.equal(flockShNb(fd).ok, true);
  assert.equal(inChild(dir, `process.stdout.write(JSON.stringify(flockExNb(fd)));`), '{"ok":false,"wouldBlock":true}');
  fs.closeSync(fd);
});

test('shared attempt against a held exclusive lock reports wouldBlock', () => {
  const dir = mkTmpDir();
  const fd = openLock(dir);
  assert.equal(flockExNb(fd).ok, true);
  assert.equal(inChild(dir, `process.stdout.write(JSON.stringify(flockShNb(fd)));`), '{"ok":false,"wouldBlock":true}');
  fs.closeSync(fd);
});

test('flockUn releases so another process can take exclusive', () => {
  const dir = mkTmpDir();
  const fd = openLock(dir);
  assert.equal(flockExNb(fd).ok, true);
  flockUn(fd);
  assert.equal(inChild(dir, `process.stdout.write(JSON.stringify(flockExNb(fd)));`), '{"ok":true,"wouldBlock":false}');
  fs.closeSync(fd);
});

test('lock dies with its process (kernel auto-release)', () => {
  const dir = mkTmpDir();
  fs.closeSync(openLock(dir)); // create the lock file for the child to open
  inChild(dir, `flockExNb(fd); process.stdout.write('held');`); // child exits, lock must vanish
  const fd = openLock(dir);
  assert.equal(flockExNb(fd).ok, true);
  fs.closeSync(fd);
});

test('acquireExWithTimeout acquires immediately when free', () => {
  const fd = openLock(mkTmpDir());
  assert.deepEqual(acquireExWithTimeout(fd, 1000, 10), { ok: true });
  fs.closeSync(fd);
});

test('acquireExWithTimeout times out while another process holds the lock', () => {
  const dir = mkTmpDir();
  const sentinel = path.join(dir, 'holder-ready');
  // Holder child keeps the lock past our timeout window; the sentinel file is
  // the "I hold it" signal (the main thread stays sync, so stdout events
  // would never be delivered here).
  const holder = require('child_process').spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const { flockExNb } = require(${JSON.stringify(FLOCK_LIB)});
    const fd = fs.openSync(${JSON.stringify(path.join(dir, 'guard.lock'))}, 'w');
    if (flockExNb(fd).ok) fs.writeFileSync(${JSON.stringify(sentinel)}, '1');
    setTimeout(() => {}, 5000); // hold until killed
  `]);
  try {
    const t0 = Date.now();
    while (!fs.existsSync(sentinel) && Date.now() - t0 < 5000) {
      sleepMs(10);
    }
    assert.equal(fs.existsSync(sentinel), true, 'holder child never reported the lock');

    const fd = openLock(dir);
    const started = Date.now();
    assert.deepEqual(acquireExWithTimeout(fd, 250, 50), { ok: false });
    assert.ok(Date.now() - started >= 250, 'returned before the timeout elapsed');
    fs.closeSync(fd);
  } finally {
    holder.kill('SIGKILL');
  }
});

test('non-EAGAIN errno propagates as a throw', () => {
  const dir = mkTmpDir();
  const fd = fs.openSync(path.join(dir, 'guard.lock'), 'w');
  fs.closeSync(fd);
  assert.throws(() => flockShNb(fd), /EBADF/);
});
