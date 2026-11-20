import { serveDecoder } from "../xlsx-runtime/server.mjs";
import { runWorker } from "./supervise.mjs";

export { jobMs } from "../xlsx-runtime/server.mjs";
export const socketPath = "/fixture-link/decoder.sock";

export function serve(path, mode, report, retire, deadlineMs) {
  if (!["decode", "abnormal", "descendant"].includes(mode)) {
    throw new Error("XLSX_FIXTURE_MODE");
  }
  return serveDecoder({
    path,
    report,
    retire,
    deadlineMs,
    runWorker: (request, job, signal) =>
      runWorker(request, job, mode, signal, () => report("DESCENDANT_READY")),
  }).server;
}
