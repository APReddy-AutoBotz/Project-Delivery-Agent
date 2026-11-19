import { parseWorkbookFrame } from "./parse.mjs";

try {
  const { frame } = await parseWorkbookFrame(process.stdin);
  process.stdout.write(frame);
} catch {
  process.exitCode = 1;
}
