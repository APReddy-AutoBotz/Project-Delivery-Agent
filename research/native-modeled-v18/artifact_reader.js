'use strict';
// EXEC-016/TR-DEP-004. Fixed private binary reader, never a public log producer.
const fs = require('fs');
const crypto = require('crypto');
const names = new Set([
  'policy.o', 'policy.d', 'policy-controls.o', 'policy-controls.d',
  'policy-install-controls.o', 'policy-install-controls.d', 'state.o', 'state.d',
  'state-controls.o', 'state-controls.d', 'observer.o', 'observer.d',
  'policy-model', 'policy.map', 'installer-model', 'installer.map', 'state-model', 'state.map',
]);
let descriptor = null;
let closeAttempted = false;
let streamFailed = false;
// Permanent handlers also cover the gaps between outstanding chunks. Never
// allow an unhandled stream error to print arbitrary exception information.
process.stdout.on('error', () => { streamFailed = true; process.exitCode = 71; });
process.stdout.on('close', () => { streamFailed = true; process.exitCode = 71; });
function requireCondition(value) { if (!value) throw new Error('PRIVATE_READER_REFUSED'); }
function closeOnce() {
  if (descriptor !== null && !closeAttempted) {
    closeAttempted = true;
    if (!Number.isInteger(descriptor) || descriptor < 3) return;
    fs.closeSync(descriptor);
    descriptor = null;
  }
}
function identity(a, b) {
  return ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
}
function writeChunk(chunk) {
  // Register before write: drain and callback can arrive in either order.
  // Only this one chunk is pending; its backing buffer stays unchanged.
  return new Promise((resolve, reject) => {
    let returned = false, callbackDone = false, needsDrain = false, drained = false, finished = false;
    function remove() {
      process.stdout.removeListener('drain', onDrain);
      process.stdout.removeListener('error', onError);
      process.stdout.removeListener('close', onClose);
    }
    function fail() {
      if (finished) return;
      finished = true; remove(); reject(new Error('PRIVATE_READER_STREAM_FAILED'));
    }
    function complete() {
      if (!finished && returned && callbackDone && (!needsDrain || drained)) {
        finished = true; remove(); resolve();
      }
    }
    function onDrain() { drained = true; complete(); }
    function onError() { fail(); }
    function onClose() { fail(); }
    process.stdout.on('drain', onDrain);
    process.stdout.on('error', onError);
    process.stdout.on('close', onClose);
    try {
      const accepted = process.stdout.write(chunk, error => {
        if (error) { fail(); return; }
        callbackDone = true; complete();
      });
      requireCondition(typeof accepted === 'boolean');
      needsDrain = !accepted; returned = true; complete();
    } catch (_) { fail(); }
  });
}
async function main() {
  requireCondition(process.argv.length === 4 && process.argv.every(value => typeof value === 'string') && names.has(process.argv[1]) &&
    /^(?:0|[1-9][0-9]{0,8})$/.test(process.argv[2]) && String(Number(process.argv[2])) === process.argv[2] &&
    process.argv[3].length === 64 && /^[0-9a-f]{64}$/.test(process.argv[3]));
  const [name, sizeText, expectedHash] = process.argv.slice(1);
  const size = Number(sizeText), maximum = name.endsWith('.d') || name.endsWith('.map') ? 1048576 : 33554432;
  requireCondition(Number.isSafeInteger(size) && size <= maximum && process.getuid() === 1000);
  const path = '/work/' + name;
  descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  requireCondition(Number.isInteger(descriptor) && descriptor >= 3);
  const before = fs.fstatSync(descriptor, {bigint: true});
  requireCondition(before.isFile() && before.uid === 1000n && before.nlink === 1n && before.size === BigInt(size));
  const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
  let count = 0;
  while (count < size) {
    requireCondition(!streamFailed);
    const wanted = Math.min(buffer.length, size - count);
    const actual = fs.readSync(descriptor, buffer, 0, wanted, null);
    requireCondition(actual === wanted);
    const chunk = buffer.subarray(0, actual);
    digest.update(chunk);
    await writeChunk(chunk);
    requireCondition(!streamFailed);
    count += actual;
  }
  requireCondition(!streamFailed && fs.readSync(descriptor, buffer, 0, 1, null) === 0 &&
    identity(before, fs.fstatSync(descriptor, {bigint: true})) &&
    identity(before, fs.lstatSync(path, {bigint: true})) && digest.digest('hex') === expectedHash);
  closeOnce();
  requireCondition(descriptor === null && closeAttempted);
}
main().catch(() => {
  // No arbitrary exception text or source bytes are written to either stream.
  try { closeOnce(); } catch (_) { /* ambiguous close is never retried */ }
  process.exitCode = 71;
  try { process.stdout.destroy(); } catch (_) { /* keep rejection private */ }
});
