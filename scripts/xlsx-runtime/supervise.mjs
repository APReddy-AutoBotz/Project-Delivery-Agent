import { finished } from "node:stream/promises";
import { decodeResult, readOneFrame, responseLimit } from "./wire.mjs";

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

export async function superviseWorker(request, job, signal, launch) {
  if (signal.aborted) return { frame: null, retire: false };
  const child = launch();
  child.on("error", () => {});
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
