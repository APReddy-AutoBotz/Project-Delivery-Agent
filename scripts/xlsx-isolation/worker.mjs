import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { parseWorkbookFrame } from "../xlsx-runtime/parse.mjs";

try {
  const mode = process.argv[2];
  const { frame: response, decoded } = await parseWorkbookFrame(process.stdin);
  if (!decoded) process.stdout.write(response);
  else {
    if (mode === "descendant") {
      const descendant = spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.of(1)); setInterval(() => {}, 1000);",
        ],
        { env: {}, stdio: ["ignore", "pipe", "ignore"] },
      );
      descendant.on("error", () => {
        process.exitCode = 1;
      });
      descendant.stdout.once("data", (data) => {
        if (data.length === 1 && data[0] === 1) {
          writeSync(3, Buffer.of(1));
          process.stdout.write(response);
        }
      });
    } else {
      process.stdout.write(response);
      if (mode === "abnormal") process.exitCode = 7;
    }
  }
} catch {
  process.exitCode = 1;
}
