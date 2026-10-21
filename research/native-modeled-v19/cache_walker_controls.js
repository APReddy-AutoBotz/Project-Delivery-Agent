// EXEC-016: actual FINAL_SCRIPT supplied-I/O controls. UNEXECUTED DRAFT.
// A future hosted immutable packet alone may execute this fixed program.
'use strict';
const vm = require('vm'), crypto = require('crypto');
const check = (value, reason) => { if (!value) throw Error(reason); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const groups = Object.freeze({
 w01: ['libc-shaped-2646-files-1326-directories'],
 w02: ['files-8192', 'files-8193'],
 w03: ['directories-2048', 'directories-2049', 'names-4096', 'names-4097'],
 w04: ['producer-json-lf-1048576', 'producer-json-lf-1048577'],
 w05: ['empty', 'missing-roots', 'chunked-65537', 'zero-file', 'name-type', 'name-empty', 'name-LF', 'name-CR',
       'name-U2028', 'name-U2029', 'name-NUL', 'name-replacement', 'name-dot', 'name-dotdot', 'root-symlink', 'directory-uid',
       'file-kind', 'file-uid', 'file-links', 'file-size-negative', 'file-size-over', 'inode-alias',
       'aggregate-over', 'open-throw', 'fstat-initial', 'read-throw', 'read-short', 'read-extra-eof',
       'fstat-final', 'path-final', 'close-throw', 'directory-close-throw', 'directory-changed', 'stdout-throw']
});
check(process.argv.length === 3 && Object.hasOwn(groups, process.argv[1]), 'exact fixed walker selector/argv');
const group = process.argv[1], source = process.argv[2];
check(typeof source === 'string' && source.length > 0 && source.length <= 16384 &&
      sha(Buffer.from(source, 'utf8')) === 'b0ec2a6d733705f6f93489f464fa4a15b3d6953d26b17c5bce109e8165aadf5a', 'exact reviewed FINAL_SCRIPT');
const roots = ['/work/local-cache', '/work/global-cache'];
let nextInode = 1n;
function tree() {
 const nodes = new Map();
 function directory(path) {
  check(!nodes.has(path), 'independent unique directory fixture');
  nodes.set(path, {kind: 'directory', ino: nextInode++, size: 0, names: []});
  const slash = path.lastIndexOf('/'), parent = nodes.get(path.slice(0, slash));
  if (parent) parent.names.push(path.slice(slash + 1));
 }
 function file(path, size = 0) {
  check(!nodes.has(path) && Number.isInteger(size) && size >= 0, 'independent unique file fixture');
  const slash = path.lastIndexOf('/'), parent = nodes.get(path.slice(0, slash));
  check(parent && parent.kind === 'directory', 'independent file parent');
  nodes.set(path, {kind: 'file', ino: nextInode++, size});
  parent.names.push(path.slice(slash + 1));
 }
 roots.forEach(directory);
 return {nodes, directory, file};
}
function base(size = 1) {
 const value = tree(); value.file('/work/global-cache/f', size); return value;
}
function numbered(index) { return index.toString(16).padStart(4, '0'); }
function fileBoundary(count) {
 const value = tree();
 for (let part = 0; part < 4; part++) value.directory('/work/global-cache/d' + part);
 for (let index = 0; index < count; index++) {
  const part = index % 4;
  value.file('/work/global-cache/d' + part + '/f' + numbered(Math.floor(index / 4)));
 }
 return value;
}
function directoryBoundary(count) {
 const value = tree();
 for (let index = 2; index < count; index++) value.directory('/work/global-cache/d' + numbered(index));
 return value;
}
function nameBoundary(count) {
 const value = tree();
 for (let index = 0; index < count; index++) value.file('/work/global-cache/f' + numbered(index));
 return value;
}
function independentRecord(value) {
 const files = [], directories = []; let total = 0;
 for (const [path, node] of value.nodes) {
  if (node.kind === 'directory') directories.push(path);
  else {
   // Independent zero-payload fixture calculation; no production helper/table.
   const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(65536);
   for (let left = node.size; left > 0; left -= Math.min(left, chunk.length)) {
    digest.update(chunk.subarray(0, Math.min(left, chunk.length)));
   }
   files.push({path, bytes: node.size, sha256: digest.digest('hex')}); total += node.size;
  }
 }
 files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
 return {schema: 1, stage: 'FINAL_AFTER_FIXED_PRODUCERS', roots: roots.slice(), files, directories, totalBytes: total};
}
function framedBoundary(bytes) {
 // A real complete JSON tree, tuned using an independent record formula.
 const count = 4096, plain = nameBoundary(count);
 const plainBytes = Buffer.byteLength(JSON.stringify(independentRecord(plain)) + '\n');
 const extra = bytes - plainBytes; check(extra >= 0, 'independent framing fixture room');
 const quotient = Math.floor(extra / count), remainder = extra % count, value = tree();
 for (let index = 0; index < count; index++) {
  value.file('/work/global-cache/f' + numbered(index) + 'x'.repeat(quotient + (index < remainder ? 1 : 0)));
 }
 check(Buffer.byteLength(JSON.stringify(independentRecord(value)) + '\n') === bytes, 'independent exact JSON-plus-LF size');
 return value;
}
function run(value, fault = null) {
 const counts = Object.create(null), descriptors = new Map(), iterators = new Set(), pathStats = new Map();
 let nextFd = 10, output = null, delivered = 0, thrown = null;
 const raw = name => { counts[name] = (counts[name] || 0) + 1; };
 function inject() { delivered++; }
 function snapshot(path, operation) {
  raw(operation);
  const node = value.nodes.get(path);
  if (!node) { const error = Error('supplied missing'); error.code = 'ENOENT'; throw error; }
  if (operation === 'lstat') pathStats.set(path, (pathStats.get(path) || 0) + 1);
  const result = {dev: 1n, ino: node.ino, size: BigInt(node.size), mtimeNs: 1n, ctimeNs: 1n,
    mode: node.kind === 'directory' ? 0o40555n : 0o100444n, nlink: 1n, uid: 1000n,
    isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file', isSymbolicLink: () => false};
  if (path === '/work/global-cache' && node.kind === 'directory') {
   if (fault === 'root-symlink') { inject(); result.isSymbolicLink = () => true; }
   if (fault === 'directory-uid') { inject(); result.uid = 999n; }
   if (fault === 'directory-changed' && pathStats.get(path) >= 3) { inject(); result.mtimeNs = 2n; }
  }
  if (node.kind === 'file') {
   if (fault === 'file-kind') { inject(); result.isFile = () => false; }
   if (fault === 'file-uid') { inject(); result.uid = 999n; }
   if (fault === 'file-links') { inject(); result.nlink = 2n; }
   if (fault === 'file-size-negative') { inject(); result.size = -1n; }
   if (fault === 'file-size-over') { inject(); result.size = 33554433n; }
   if (fault === 'fstat-initial' && operation === 'fstat' && counts.fstat === 1) { inject(); result.ino += 1n; }
   if (fault === 'fstat-final' && operation === 'fstat' && counts.fstat === 2) { inject(); result.ctimeNs = 2n; }
   if (fault === 'path-final' && operation === 'lstat' && pathStats.get(path) >= 2) { inject(); result.ctimeNs = 2n; }
  }
  return result;
 }
 const invalidNames = { 'name-empty': '', 'name-LF': 'f\n', 'name-CR': 'f\r', 'name-U2028': 'f\u2028',
   'name-U2029': 'f\u2029', 'name-NUL': 'f\0', 'name-replacement': 'f\ufffd', 'name-dot': '.', 'name-dotdot': '..' };
 const fs = {
  constants: Object.freeze({O_RDONLY: 0, O_NOFOLLOW: 131072}),
  lstatSync(path, options) { check(options && options.bigint === true, 'actual bigint lstat'); return snapshot(path, 'lstat'); },
  opendirSync(path) {
   raw('opendir'); const node = value.nodes.get(path); check(node && node.kind === 'directory', 'supplied directory');
   const token = {}; iterators.add(token); let at = 0;
   return {
    readSync() {
     raw('readdir'); check(iterators.has(token), 'read closed supplied directory');
     if (at >= node.names.length) return null;
     let name = node.names[at++];
     if (path === '/work/global-cache' && at === 1) {
      if (Object.hasOwn(invalidNames, fault)) { inject(); name = invalidNames[fault]; }
      if (fault === 'name-type') { inject(); name = {toString() { throw Error('must not coerce supplied name'); }}; }
     }
     return {name};
    },
    closeSync() {
     raw('closedir'); check(iterators.has(token), 'duplicate supplied directory close');
     iterators.delete(token);
     if (fault === 'directory-close-throw') { inject(); throw Error('supplied directory close'); }
    }
   };
  },
  openSync(path, flags) {
   raw('open'); check(flags === 131072, 'actual exact no-follow open flags');
   if (fault === 'open-throw') { inject(); throw Error('supplied open'); }
   const node = value.nodes.get(path); check(node && node.kind === 'file', 'supplied ordinary file open');
   const fd = nextFd++; descriptors.set(fd, {path, offset: 0}); return fd;
  },
  fstatSync(fd, options) {
   check(options && options.bigint === true && descriptors.has(fd), 'actual retained fstat');
   return snapshot(descriptors.get(fd).path, 'fstat');
  },
  readSync(fd, buffer, offset, wanted, position) {
   raw('read'); check(descriptors.has(fd) && Buffer.isBuffer(buffer) && offset === 0 && wanted > 0 &&
     wanted <= 65536 && position === null, 'actual bounded sequential supplied read');
   const descriptor = descriptors.get(fd), node = value.nodes.get(descriptor.path);
   if (fault === 'read-throw') { inject(); throw Error('supplied read'); }
   if (fault === 'read-short' && descriptor.offset < node.size) { inject(); return wanted - 1; }
   if (descriptor.offset === node.size) {
    if (fault === 'read-extra-eof') { inject(); buffer[0] = 0; return 1; }
    return 0;
   }
   const count = Math.min(wanted, node.size - descriptor.offset);
   buffer.fill(0, 0, count); descriptor.offset += count; return count;
  },
  closeSync(fd) {
   raw('close'); check(descriptors.has(fd), 'duplicate/foreign supplied file close'); descriptors.delete(fd);
   if (fault === 'close-throw') { inject(); throw Error('supplied file close'); }
  }
 };
 const suppliedProcess = {stdout: {write(text) {
  raw('stdout'); check(typeof text === 'string' && output === null, 'one actual complete producer write');
  output = text;
  if (fault === 'stdout-throw') { inject(); throw Error('supplied stdout'); }
  return true;
 }}};
 try {
  vm.runInNewContext(source, {Buffer, process: suppliedProcess,
   require(name) { raw('require'); check(name === 'fs' || name === 'crypto', 'fixed supplied module');
    return name === 'fs' ? fs : Object.freeze({createHash: crypto.createHash}); }});
 } catch (error) { thrown = error; }
 return {counts, output, delivered, thrown, descriptors, iterators};
}
const seen = [];
function positive(name, value, wanted = null) {
 const expected = JSON.stringify(independentRecord(value)) + '\n', result = run(value);
 check(result.thrown === null && result.output === expected && result.counts.stdout === 1 &&
       result.descriptors.size === 0 && result.iterators.size === 0 && result.delivered === 0,
       'external successful actual producer/identity/closure: ' + name);
 if (wanted !== null) check(Buffer.byteLength(result.output) === wanted, 'external exact framed boundary: ' + name);
 seen.push(name);
}
function negative(name, value, fault, message, beforeOpen = false, injected = true) {
 const result = run(value, fault);
 check(result.thrown && result.thrown.message === message &&
       (fault === 'stdout-throw' ? result.counts.stdout === 1 : result.output === null && !result.counts.stdout),
       'external actual producer refusal and no ordinary write: ' + name);
 if (injected) check(result.delivered > 0, 'external fault delivered at actual raw entry: ' + name);
 if (beforeOpen) check(!result.counts.open && !result.counts.read, 'external no open/read after invalid metadata: ' + name);
 check(result.descriptors.size === 0 && result.iterators.size === 0, 'external supplied handles closed: ' + name);
 seen.push(name);
}
if (group === 'w01') {
 const value = tree(); value.directory('/work/global-cache/o');
 for (let index = 0; index < 1323; index++) {
  const parent = '/work/global-cache/o/' + index.toString(16).padStart(32, '0');
  value.directory(parent); value.file(parent + '/object.o', 1); value.file(parent + '/manifest', 1);
 }
 check(value.nodes.size === 2646 + 1326, 'independent libc-shaped totals');
 positive(groups.w01[0], value);
} else if (group === 'w02') {
 positive('files-8192', fileBoundary(8192));
 negative('files-8193', fileBoundary(8193), null, 'cache file kind/budget', false, false);
} else if (group === 'w03') {
 positive('directories-2048', directoryBoundary(2048));
 negative('directories-2049', directoryBoundary(2049), null, 'cache directory', true, false);
 positive('names-4096', nameBoundary(4096));
 negative('names-4097', nameBoundary(4097), null, 'cache enumeration capacity', true, false);
} else if (group === 'w04') {
 positive('producer-json-lf-1048576', framedBoundary(1048576), 1048576);
 negative('producer-json-lf-1048577', framedBoundary(1048577), null, 'cache evidence budget', false, false);
} else {
 positive('empty', tree());
 const missing = tree(); missing.nodes.clear(); positive('missing-roots', missing);
 positive('chunked-65537', base(65537)); positive('zero-file', base(0));
 for (const name of groups.w05.slice(4, 14)) negative(name, base(), name, 'cache path', true);
 negative('root-symlink', base(), 'root-symlink', 'cache root kind', true);
 negative('directory-uid', base(), 'directory-uid', 'cache directory', true);
 for (const name of ['file-kind', 'file-uid', 'file-links', 'file-size-negative', 'file-size-over'])
  negative(name, base(), name, 'cache file kind/budget', true);
 const alias = base(); alias.file('/work/global-cache/g', 1);
 alias.nodes.get('/work/global-cache/g').ino = alias.nodes.get('/work/global-cache/f').ino;
 negative('inode-alias', alias, null, 'cache inode alias', false, false);
 const aggregate = tree();
 for (let index = 0; index < 9; index++) aggregate.file('/work/global-cache/f' + index, 33554432);
 negative('aggregate-over', aggregate, null, 'cache aggregate', false, false);
 negative('open-throw', base(), 'open-throw', 'supplied open');
 negative('fstat-initial', base(), 'fstat-initial', 'cache open identity');
 negative('read-throw', base(), 'read-throw', 'supplied read');
 negative('read-short', base(), 'read-short', 'cache short read');
 negative('read-extra-eof', base(), 'read-extra-eof', 'cache read identity');
 negative('fstat-final', base(), 'fstat-final', 'cache read identity');
 negative('path-final', base(), 'path-final', 'cache read identity');
 negative('close-throw', base(), 'close-throw', 'supplied file close');
 negative('directory-close-throw', base(), 'directory-close-throw', 'supplied directory close', true);
 negative('directory-changed', base(), 'directory-changed', 'cache directory changed');
 negative('stdout-throw', base(), 'stdout-throw', 'supplied stdout');
}
check(JSON.stringify(seen) === JSON.stringify(groups[group]) && new Set(seen).size === seen.length,
      'external complete exact disjoint walker group membership');
process.stdout.write(JSON.stringify({schema: 1, status: 'SUPPLIED_CACHE_WALKER_CONTROLS_PASS', group,
 cases: seen.length, names: seen, realCacheReads: 0, nativeQualification: false}) + '\n');
