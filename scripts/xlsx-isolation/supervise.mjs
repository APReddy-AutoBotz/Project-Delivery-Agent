import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { decodeResult, readOneFrame, responseLimit } from "./wire.mjs";

const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));

// Only signal the group created for this child in the dedicated Linux PID namespace.
function signalGroup(pid, signal) {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function runWorker(request, job, mode, signal, noteDescendant) {
  if (signal.aborted) return { frame: null, retire: false };
  const child = spawn(process.execPath, [worker, mode], {
    detached: true,
    env: {},
    stdio: [
      "pipe",
      "pipe",
      "ignore",
      mode === "descendant" ? "pipe" : "ignore",
    ],
  });
  child.on("error", () => {});
  if (mode === "descendant") {
    child.stdio[3].on("error", () => {});
    child.stdio[3].once("data", (data) => {
      if (data.length === 1 && data[0] === 1) noteDescendant();
    });
  }
  const closed = new Promise((resolve) => {
    child.once("close", (code, childSignal) => resolve({ code, childSignal }));
  });
  const written = finished(child.stdin, {
    readable: false,
    cleanup: true,
  }).then(
    () => true,
    () => false,
  );
  const read = readOneFrame(child.stdout, responseLimit).catch(() => null);
  const complete = Promise.all([closed, written, read]);
  let abort;
  const interrupted = new Promise((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
  });
  child.stdin.end(request);
  let result;
  try {
    result = await Promise.race([complete, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (!result || signal.aborted || signalGroup(child.pid, 0)) {
    signalGroup(child.pid, "SIGKILL");
    return { frame: null, retire: true };
  }
  const [{ code, childSignal }, inputComplete, frame] = result;
  if (!inputComplete || code !== 0 || childSignal !== null || !frame) {
    return { frame: null, retire: false };
  }
  try {
    decodeResult(frame, job);
    return { frame, retire: false };
  } catch {
    return { frame: null, retire: false };
  }
}
