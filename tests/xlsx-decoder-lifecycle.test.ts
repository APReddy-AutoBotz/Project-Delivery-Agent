import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { IsolatedXlsxDecoder } from "../packages/platform/src/xlsx-decoder.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.useRealTimers());

test.skipIf(process.platform !== "linux")(
  "a bridge that does not close cannot extend the deadline or restore its lease",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof spawn>,
    );
    const decoder = new IsolatedXlsxDecoder({
      bridge: "/fixture/bridge",
      socket: "/fixture/socket",
      peerUid: 1001,
      peerGid: 2000,
      timeoutMs: 100,
    });

    const lease = decoder.tryAcquire()!;
    const result = lease.decode(
      { sheet: "Portfolio", parserContract: "portable-v1" },
      Buffer.from("fixture"),
    );
    const rejection = expect(result).rejects.toThrow(
      "XLSX_DECODER_UNAVAILABLE",
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(decoder.tryAcquire()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(child.unref).toHaveBeenCalledOnce();
    lease.release();
    expect(decoder.tryAcquire()).toBeNull();
    child.emit("close", 1);
    expect(decoder.tryAcquire()).toBeNull();
  },
);
