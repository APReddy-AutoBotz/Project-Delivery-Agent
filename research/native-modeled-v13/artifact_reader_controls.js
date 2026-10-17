'use strict';
// EXEC-016/TR-DEP-004. Supplied boundaries around the actual frozen reader.
// SOURCE ONLY. Run only inside a completely reviewed research packet.
const vm = require('vm');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const source = process.argv[1];
const readerSha256 = '29c2b4969a0a8fe18aaab89629bf1f46822698a18cc70b7d79438d280052710e';
const sentinel = Buffer.from([0, 255, 254, 128, 10, 80, 82, 73, 86, 65, 84, 69]);
const cases = [];
function check(value) { if (!value) throw new Error('CONTROL_ASSERTION'); }
function authenticateReader(value) {
  check(typeof value === 'string' && 0 < value.length && value.length <= 16384 && Buffer.byteLength(value, 'utf8') <= 16384 &&
    crypto.createHash('sha256').update(value, 'utf8').digest('hex') === readerSha256);
  return value;
}
check(process.argv.length === 2);
authenticateReader(source);
function bytes(size) {
  const value = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += sentinel.length) sentinel.copy(value, offset);
  return value;
}
async function supplied(options = {}) {
  const data = bytes(options.size === undefined ? 65537 : options.size);
  const expectedHash = crypto.createHash('sha256').update(data).digest('hex');
  const state = {position: 0, reads: [], emitted: [], pending: 0, peak: 0, opens: 0, closes: 0,
    fstats: 0, lstats: 0, writes: 0, destroys: 0, delivered: false, errors: [], public: [], awaitingDrain: false};
  const fault = options.fault;
  function guarded(body) {
    return (...args) => {
      try { return body(...args); }
      catch (error) {
        if (error.message === 'CONTROL_ASSERTION') state.errors.push('CALLBACK_ASSERTION');
        throw error;
      }
    };
  }
  function fail(point) {
    if (fault === point && !state.delivered) {
      state.delivered = true;
      throw new Error('PRIVATE-BINARY-EXCEPTION-\u0000\u00ff');
    }
  }
  function info() {
    return {dev: 4n, ino: 9n, mode: 0o100600n, uid: 1000n, nlink: 1n, size: BigInt(data.length),
      mtimeNs: 11n, ctimeNs: 12n, isFile: () => true};
  }
  const output = new EventEmitter();
  output.write = guarded((chunk, callback) => {
    check(Buffer.isBuffer(chunk) && chunk.length > 0 && chunk.length <= 65536 && typeof callback === 'function' &&
      state.pending === 0 && !state.awaitingDrain);
    state.writes++;
    state.pending++;
    state.peak = Math.max(state.peak, state.pending);
    const snapshot = Buffer.from(chunk);
    function finish() {
      check(chunk.equals(snapshot)); // a pending buffer was never refilled
      state.pending--;
      state.emitted.push(snapshot);
      if (fault === 'callback-error') {
        state.delivered = true;
        callback(new Error('PRIVATE-BINARY-CALLBACK'));
      } else {
        callback();
      }
      if (fault === 'gap-error') {
        state.delivered = true;
        output.emit('error', new Error('PRIVATE-BINARY-GAP'));
      }
    }
    const finishGuarded = guarded(finish);
    if (fault === 'write-throw') {
      state.pending--;
      fail('write-throw');
    }
    if (fault === 'stream-error' || fault === 'stream-close') {
      queueMicrotask(guarded(() => {
        state.delivered = true;
        state.pending--;
        output.emit(fault === 'stream-error' ? 'error' : 'close', new Error('PRIVATE-BINARY-STREAM'));
      }));
      return false;
    }
    if (options.order === 'sync') {
      finishGuarded();
      return true;
    }
    if (options.order === 'drain-before-return') {
      state.awaitingDrain = true;
      state.awaitingDrain = false;
      output.emit('drain');
      queueMicrotask(finishGuarded);
      return false;
    }
    if (options.order === 'callback-before-drain') {
      state.awaitingDrain = true;
      queueMicrotask(guarded(() => {
        finishGuarded();
        setImmediate(guarded(() => { state.awaitingDrain = false; output.emit('drain'); }));
      }));
      return false;
    }
    if (options.order === 'drain-before-callback') {
      state.awaitingDrain = true;
      queueMicrotask(guarded(() => { state.awaitingDrain = false; output.emit('drain'); finishGuarded(); }));
      return false;
    }
    queueMicrotask(finishGuarded);
    if (fault === 'write-invalid-result') {
      state.delivered = true;
      return 1;
    }
    return true;
  });
  output.destroy = guarded(() => { state.destroys++; fail('destroy-throw'); });
  const constants = {O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: 2048};
  const fakeFs = {
    constants,
    openSync: guarded((path, flags) => {
      check(path === '/work/' + (options.name || 'policy.o') && flags === 133120);
      state.opens++;
      fail('open-throw');
      if (fault === 'invalid-fd') { state.delivered = true; return 1; }
      return 11;
    }),
    fstatSync: guarded((descriptor, settings) => {
      check(descriptor === 11 && settings.bigint === true && Object.keys(settings).length === 1);
      state.fstats++;
      fail('fstat-throw');
      const value = info();
      const initial = {kind: () => { value.isFile = () => false; }, uid: () => { value.uid = 999n; },
        links: () => { value.nlink = 2n; }, size: () => { value.size++; }};
      if (fault && fault.startsWith('initial-') && initial[fault.slice(8)]) {
        state.delivered = true;
        initial[fault.slice(8)]();
      }
      if (fault === 'changed-fstat' && state.fstats === 2) {
        state.delivered = true;
        value.ctimeNs++;
      }
      return value;
    }),
    readSync: guarded((descriptor, buffer, offset, wanted, position) => {
      check(descriptor === 11 && Buffer.isBuffer(buffer) && buffer.length === 65536 && offset === 0 &&
        Number.isInteger(wanted) && wanted > 0 && wanted <= 65536 && position === null &&
        state.pending === 0 && !state.awaitingDrain);
      state.reads.push(wanted);
      fail('read-throw');
      if (state.position === data.length) {
        check(wanted === 1);
        if (fault === 'extra-byte') { state.delivered = true; return 1; }
        return 0;
      }
      check(wanted === Math.min(65536, data.length - state.position));
      if (fault === 'short-read') { state.delivered = true; return wanted - 1; }
      if (fault === 'invalid-read') { state.delivered = true; return true; }
      data.copy(buffer, 0, state.position, state.position + wanted);
      state.position += wanted;
      return wanted;
    }),
    lstatSync: guarded((path, settings) => {
      check(path === '/work/' + (options.name || 'policy.o') && settings.bigint === true);
      state.lstats++;
      fail('lstat-throw');
      const value = info();
      if (fault === 'changed-path') { state.delivered = true; value.ino++; }
      return value;
    }),
    closeSync: guarded(descriptor => {
      check(descriptor === 11 && state.closes === 0);
      state.closes++;
      fail('close-throw');
    }),
  };
  const fakeProcess = {argv: ['node', options.name || 'policy.o', String(data.length), expectedHash], stdout: output,
    stderr: {write: value => { state.public.push(value); }}, getuid: () => options.uid === undefined ? 1000 : options.uid,
    exitCode: undefined, exit: () => { state.errors.push('UNEXPECTED_PROCESS_EXIT'); }};
  if (options.argv) fakeProcess.argv = options.argv;
  if (fault === 'wrong-hash') { fakeProcess.argv[3] = '0'.repeat(64); state.delivered = true; }
  const context = {Buffer, process: fakeProcess, require: name => {
    check(name === 'fs' || name === 'crypto');
    return name === 'fs' ? fakeFs : crypto;
  }};
  let rejected = false;
  let timer;
  try {
    await Promise.race([vm.runInNewContext(source, context, {timeout: 1000}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CONTROL_TIMEOUT')), 250); })]);
    await new Promise(resolve => queueMicrotask(resolve));
  } catch (_) { rejected = true; }
  finally { clearTimeout(timer); }
  check(!rejected && state.errors.length === 0 && state.public.length === 0 && state.pending === 0 && !state.awaitingDrain &&
    state.peak <= 1 && state.closes <= 1 && output.listenerCount('drain') === 0 &&
    output.listenerCount('error') === 1 && output.listenerCount('close') === 1);
  if (options.reject) {
    check(fakeProcess.exitCode === 71 && state.destroys === 1);
    if (options.fault) check(state.delivered);
    if (options.noOpen) check(state.opens === 0);
    if (options.fault === 'invalid-fd') check(state.closes === 0);
  } else {
    check(fakeProcess.exitCode === undefined && state.destroys === 0 && state.closes === 1 &&
      state.fstats === 2 && state.lstats === 1 && Buffer.concat(state.emitted).equals(data) &&
      state.reads[state.reads.length - 1] === 1);
  }
}
async function main() {
  const lookalike = source.replace('=', '\u013d');
  check(lookalike !== source);
  for (const alternate of [null, source + '\n', lookalike]) {
    let refused = false;
    try { authenticateReader(alternate); } catch (_) { refused = true; }
    check(refused);
    cases.push('reader-source-identity-' + cases.length);
  }
  for (const size of [0, 1, 65535, 65536, 65537, 1048576, 33554432]) {
    await supplied({size}); cases.push('size-' + size);
  }
  for (const order of ['sync', 'drain-before-return', 'callback-before-drain', 'drain-before-callback']) {
    await supplied({order}); cases.push('write-order-' + order);
  }
  for (const fault of ['open-throw', 'invalid-fd', 'fstat-throw', 'initial-kind', 'initial-uid', 'initial-links',
    'initial-size', 'read-throw', 'short-read', 'invalid-read', 'extra-byte', 'changed-fstat', 'changed-path',
    'lstat-throw', 'close-throw', 'write-throw', 'write-invalid-result', 'callback-error', 'stream-error',
    'stream-close', 'gap-error', 'wrong-hash', 'destroy-throw']) {
    // The destroy boundary is entered only after another fixed admission failure.
    await supplied({fault, reject: true, ...(fault === 'destroy-throw' ? {uid: 999, noOpen: true} : {})});
    cases.push(fault);
  }
  for (const argv of [['node', '../policy.o', '0', 'b'.repeat(64)], ['node', 'policy.o', '01', 'b'.repeat(64)],
    ['node', 'policy.o', '33554433', 'b'.repeat(64)], ['node', 'policy.map', '1048577', 'b'.repeat(64)],
    ['node', 'policy.o', '0', 'B'.repeat(64)], ['node', 'policy.o', '0'], ['node', 'policy.o', 0, 'b'.repeat(64)],
    ['node', 'policy.o', '0\n', 'b'.repeat(64)], ['node', 'policy.o', '0', 'b'.repeat(64) + '\n']]) {
    await supplied({size: 0, argv, reject: true, noOpen: true}); cases.push('argv-' + cases.length);
  }
  process.stdout.write(JSON.stringify({schema: 1, status: 'SUPPLIED_READER_CONTROLS_PASS', cases: cases.length,
    names: cases, realArtifactReads: 0, nativeQualification: false}) + '\n');
}
main().catch(() => {
  process.stdout.write('{"schema":1,"status":"SUPPLIED_READER_CONTROLS_FAILED"}\n');
  process.exitCode = 71;
});
