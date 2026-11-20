import { chmodSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { finished } from "node:stream/promises";
import { decodeRequest, readOneFrame, requestLimit } from "./wire.mjs";

export const jobMs = 8_000;

export function serveDecoder({
  path,
  runWorker,
  report,
  retire,
  deadlineMs = jobMs,
}) {
  let active = false;
  let retired = false;
  let onDrained;
  const server = createServer(
    { allowHalfOpen: true, pauseOnConnect: true },
    (socket) => {
      socket.on("error", () => {});
      if (active || retired || onDrained) {
        socket.destroy();
        return;
      }
      active = true;
      const controller = new AbortController();
      const expires = performance.now() + deadlineMs;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deadlineMs);
      controller.signal.addEventListener("abort", () => socket.destroy(), {
        once: true,
      });
      socket.once("close", () => controller.abort());
      async function handle() {
        let outputStarted = false;
        let outputCompleted = false;
        try {
          const request = await readOneFrame(socket, requestLimit);
          const { job } = decodeRequest(request);
          if (controller.signal.aborted || performance.now() >= expires) return;
          let result;
          try {
            result = await runWorker(request, job, controller.signal);
          } catch {
            retired = true;
            retire();
            return;
          }
          if (result.retire) {
            retired = true;
            retire();
            return;
          }
          if (
            !result.frame ||
            controller.signal.aborted ||
            performance.now() >= expires
          )
            return;
          // Keep the frame incomplete until the write callback and the final
          // deadline check. EOF after an interrupted write cannot validate it.
          outputStarted = true;
          const sent = await new Promise((resolve) =>
            socket.write(result.frame.subarray(0, -1), (error) =>
              resolve(!error),
            ),
          );
          if (
            sent &&
            !controller.signal.aborted &&
            performance.now() < expires
          ) {
            const completed = finished(socket, {
              readable: false,
              cleanup: true,
            });
            socket.end(result.frame.subarray(-1));
            await completed;
            outputCompleted =
              !controller.signal.aborted && performance.now() < expires;
          }
        } finally {
          if (
            outputStarted &&
            !outputCompleted &&
            performance.now() >= expires
          ) {
            report("OUTPUT_DEADLINE");
          }
          clearTimeout(timer);
          socket.destroy();
          active = false;
          if (onDrained && (timedOut || performance.now() >= expires)) {
            retired = true;
            retire();
          } else if (onDrained && !retired) {
            server.close(onDrained);
          }
        }
      }
      // Malformed frames, early disconnect and failed output have no response.
      handle().catch(() => {});
    },
  );
  server.on("error", () => {
    retired = true;
    retire();
  });
  server.listen({ path, backlog: 1 }, () => {
    chmodSync(path, 0o660);
    if (!lstatSync(path).isSocket()) throw new Error("XLSX_DECODER_ENDPOINT");
    report("READY");
  });
  return {
    server,
    drain(callback) {
      if (!server.listening || retired) {
        retire();
        return;
      }
      onDrained = callback;
      if (!active) server.close(onDrained);
    },
  };
}
