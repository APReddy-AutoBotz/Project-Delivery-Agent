"""EXEC-016: fixed research cache observations and map reconciliation.

No process execution here. The exact driver owns the two fixed Node inquiries.
Fresh-cache observations and a closed producer chain are research evidence,
not proof of exact per-process production or operational containment.
"""
import json
from pathlib import PurePosixPath
import re

ROOTS = ("/work/local-cache", "/work/global-cache")

INITIAL_SCRIPT = """const fs=require('fs');
const directory=fs.opendirSync('/work');
try{if(directory.readSync()!==null)throw Error('fresh work directory is not empty');}finally{directory.closeSync();}
process.stdout.write(JSON.stringify({schema:1,stage:'INITIAL_EMPTY',roots:['/work/local-cache','/work/global-cache'],files:[],directories:[],totalBytes:0})+'\\n');
"""

FINAL_SCRIPT = """const fs=require('fs'),crypto=require('crypto');
const roots=['/work/local-cache','/work/global-cache'],files=[],directories=[],inodes=new Set();let total=0;
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.mode===b.mode&&a.nlink===b.nlink&&a.uid===b.uid;}
function walk(p){
 if(p.length>1024)throw Error('cache path length');
 const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.uid!==1000n||directories.length>=2048)throw Error('cache directory');
 directories.push(p);
 const names=[];const directory=fs.opendirSync(p);
 try{let entry;while((entry=directory.readSync())!==null){if(names.length>=4096)throw Error('cache enumeration capacity');names.push(entry.name);}}
 finally{directory.closeSync();}
 for(const name of names.sort()){
  if(!/^[A-Za-z0-9_.+-]+$/.test(name)||name==='.'||name==='..')throw Error('cache path');
  const q=p+'/'+name;if(q.length>1024)throw Error('cache path length');const b=fs.lstatSync(q,{bigint:true});
  if(b.isDirectory()){walk(q);continue;}
  if(!b.isFile()||b.nlink!==1n||b.uid!==1000n||b.size<0n||b.size>33554432n||files.length>=2048)throw Error('cache file kind/budget');
  const identity=b.dev.toString()+':'+b.ino.toString();if(inodes.has(identity))throw Error('cache inode alias');inodes.add(identity);
  const size=Number(b.size);if(total+size>268435456)throw Error('cache aggregate');total+=size;
  let count=0,hash;const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);
  const fd=fs.openSync(q,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   if(!same(b,fs.fstatSync(fd,{bigint:true})))throw Error('cache open identity');
   while(count<size){const wanted=Math.min(buffer.length,size-count),n=fs.readSync(fd,buffer,0,wanted,null);if(n!==wanted)throw Error('cache short read');digest.update(buffer.subarray(0,n));count+=n;}
   if(fs.readSync(fd,buffer,0,1,null)!==0||!same(b,fs.fstatSync(fd,{bigint:true}))||!same(b,fs.lstatSync(q,{bigint:true})))throw Error('cache read identity');
   hash=digest.digest('hex');
  }finally{fs.closeSync(fd);}
  files.push({path:q,bytes:size,sha256:hash});
 }
 if(!same(s,fs.lstatSync(p,{bigint:true})))throw Error('cache directory changed');
}
for(const root of roots){let s;try{s=fs.lstatSync(root,{bigint:true});}catch(error){if(error&&error.code==='ENOENT')continue;throw error;}if(!s.isDirectory()||s.isSymbolicLink())throw Error('cache root kind');walk(root);}
files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);directories.sort();
const out=JSON.stringify({schema:1,stage:'FINAL_AFTER_FIXED_PRODUCERS',roots,files,directories,totalBytes:total})+'\\n';
if(Buffer.byteLength(out)>524288)throw Error('cache evidence budget');process.stdout.write(out);
"""


def require(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(path):
    require(type(path) is str and len(path) <= 1024 and str(PurePosixPath(path)) == path and
            re.fullmatch(r"/work/(?:local-cache|global-cache)(?:/[A-Za-z0-9_.+-]+)*", path) and
            all(part not in ("", ".", "..") for part in path.split("/")[1:]) and
            any(path == root or path.startswith(root + "/") for root in ROOTS), "cache canonical owned path")
    return path


def decode(payload, initial):
    require(type(payload) is bytes and len(payload) <= 524288, "cache receipt byte budget")
    def unique_pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "cache duplicate decoded JSON key")
            value[key] = item
        return value

    def nonfinite(value):
        raise ValueError("cache nonfinite JSON number")

    value = json.loads(payload, object_pairs_hook=unique_pairs, parse_constant=nonfinite)
    require(type(value) is dict and set(value) == {"schema", "stage", "roots", "files", "directories", "totalBytes"} and
            type(value["schema"]) is int and value["schema"] == 1 and value["roots"] == list(ROOTS) and
            value["stage"] == ("INITIAL_EMPTY" if initial else "FINAL_AFTER_FIXED_PRODUCERS"), "cache receipt schema")
    files, directories = value["files"], value["directories"]
    require(type(files) is list and len(files) <= 2048 and type(directories) is list and len(directories) <= 2048,
            "cache receipt counts")
    require(all(type(p) is str for p in directories) and directories == sorted(set(directories)) and
            all(canonical(p) for p in directories) and all(p in ROOTS or PurePosixPath(p).parent.as_posix() in directories
                for p in directories), "cache directory set")
    rows = {}
    for row in files:
        require(type(row) is dict and set(row) == {"path", "bytes", "sha256"}, "cache file schema")
        path = canonical(row["path"])
        require(path not in rows and path not in ROOTS and PurePosixPath(path).parent.as_posix() in directories and
                path not in directories and
                type(row["bytes"]) is int and 0 <= row["bytes"] <= 33554432 and type(row["sha256"]) is str and
                re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "cache file identity")
        rows[path] = row
    require([r["path"] for r in files] == sorted(rows) and type(value["totalBytes"]) is int and
            value["totalBytes"] == sum(r["bytes"] for r in files) <= 268435456, "cache payload accounting")
    if initial:
        require(not files and not directories and value["totalBytes"] == 0, "cache preseeded inputs")
    return rows


def producer_chain(events, expected):
    observed = [event for event in events if event.get("id") in expected]
    require([event["id"] for event in observed] == list(expected), "cache complete fixed producer sequence")
    result = []
    for event in observed:
        status = event.get("status")
        require(status in {"PASSED", "FAILED", "SKIPPED_FAILED_DEPENDENCY"}, "cache producer not closed")
        acquired = type(event.get("hostPid")) is int and event["hostPid"] > 0
        require(acquired if status != "SKIPPED_FAILED_DEPENDENCY" else event["id"].startswith("link-") and not acquired,
                "cache host command observation or skipped-link identity")
        result.append(dict(id=event["id"], status=status, hostCommandEntryObserved=acquired))
    return result


def map_inputs(payload, cache_rows, first_party):
    require(type(payload) is bytes and 0 < len(payload) <= 1048576 and b"\0" not in payload,
            "cache bounded original map")
    lines = payload.decode("ascii", "strict").splitlines()
    header = "VMA".rjust(16) + " " + "LMA".rjust(16) + "     Size Align Out     In      Symbol"
    require(lines and lines[0] == header and len(lines) <= 100000, "fixed ELF64 LLD20 map header/count")
    inputs = set()
    for line in lines[1:]:
        match = re.fullmatch(r"([ 0-9a-f]{16}) ([ 0-9a-f]{16}) ([ 0-9a-f]{8}) ([ 0-9]{5}) (.+)", line)
        require(match is not None and all(group.strip() for group in match.groups()[:4]), "LLD20 complete numeric row")
        for group in match.groups()[:3]:
            int(group, 16)
        int(match.group(4), 10)
        body = match.group(5)
        require(len(body) <= 4096 and all(32 <= ord(c) <= 126 for c in body), "LLD20 bounded printable body")
        if body.startswith(" " * 16):
            require(len(body) > 16 and body[16] != " ", "LLD20 exact symbol indentation")
            continue
        if not body.startswith(" "):
            require(re.fullmatch(r"\.[A-Za-z0-9_.$+-]+", body) or
                    re.fullmatch(r"[A-Za-z_.$][A-Za-z0-9_.$]* = [A-Za-z0-9_.$ ()+*<>&|!~-]+", body),
                    "LLD20 output section/assignment row")
            continue
        require(body.startswith(" " * 8) and len(body) > 8 and body[8] != " ", "LLD20 exact input indentation")
        section = re.fullmatch(r"(.+):\(([A-Za-z0-9_.$+-]+)\)", body[8:])
        require(section is not None, "LLD20 complete input section descriptor")
        descriptor = section.group(1)
        if descriptor == "<internal>":
            continue  # linker-generated synthetic section; no external file identity
        archive = re.fullmatch(r"([^()]+\.a)\(([^()]+\.o)\)", descriptor)
        if archive:
            path, member = archive.groups()
            require(not member.startswith("/") and str(PurePosixPath(member)) == member and
                    all(part not in ("", ".", "..") for part in member.split("/")) and
                    re.fullmatch(r"[A-Za-z0-9_./+-]+", member), "LLD20 bounded archive member identity")
        else:
            require(re.fullmatch(r"[^()]+\.o", descriptor), "LLD20 unrecognized object/library input")
            path = descriptor
        require(len(path) <= 1024 and str(PurePosixPath(path)) == path and ".." not in path.split("/"),
                "cache map traversal")
        if path in first_party:
            inputs.add(path)
            continue
        canonical(path)
        require(path in cache_rows, "unexplained cache object or library input")
        inputs.add(path)
    require(inputs, "cache map input census absent")
    return sorted(inputs)
