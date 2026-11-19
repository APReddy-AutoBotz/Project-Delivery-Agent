import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import {
  decodeResult,
  encodeRequest,
  readOneFrame,
  responseLimit,
  type XlsxWireGrid,
} from "./xlsx-wire.js";

type DecodeInput = {
  sheet: string;
  parserContract: "portable-v1" | "excel-text-v1";
};

export type XlsxPreviewDecoder = {
  tryAcquire(): {
    decode(
      input: DecodeInput,
      workbook: Buffer,
      signal?: AbortSignal,
    ): Promise<XlsxWireGrid | null>;
    release(): void;
  } | null;
};

type DecoderOptions = {
  bridge: string;
  socket: string;
  peerUid: number;
  peerGid: number;
  timeoutMs: number;
};

function validIdentity(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < 0xffff_ffff;
}

export class IsolatedXlsxDecoder implements XlsxPreviewDecoder {
  private readonly options: DecoderOptions;
  private reserved = false;
  private retired = false;

  constructor(options: DecoderOptions) {
    if (
      process.platform !== "linux" ||
      !isAbsolute(options.bridge) ||
      !isAbsolute(options.socket) ||
      !validIdentity(options.peerUid) ||
      !validIdentity(options.peerGid) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30_000
    ) {
      throw new Error("XLSX_DECODER_CONFIGURATION");
    }
    this.options = { ...options };
  }

  tryAcquire(): ReturnType<XlsxPreviewDecoder["tryAcquire"]> {
    if (this.reserved || this.retired) return null;
    this.reserved = true;
    let started = false;
    let pending = false;
    let released = false;
    return {
      decode: async (input, workbook, signal) => {
        if (started || released) throw new Error("XLSX_DECODER_LEASE");
        started = true;
        pending = true;
        try {
          return await this.decode(input, workbook, signal);
        } finally {
          pending = false;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        if (pending) this.retired = true;
        this.reserved = false;
      },
    };
  }

  private async decode(
    { sheet, parserContract }: DecodeInput,
    workbook: Buffer,
    signal?: AbortSignal,
  ): Promise<XlsxWireGrid | null> {
    signal?.throwIfAborted();
    const { bridge, socket, peerUid, peerGid, timeoutMs } = this.options;
    const deadline = performance.now() + timeoutMs;
    const job = randomBytes(16);
    const profile =
      parserContract === "portable-v1" ? "portable" : parserContract;
    const request = encodeRequest(job, sheet, workbook, profile);

    const child = spawn(bridge, [socket, String(peerUid), String(peerGid)], {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise<boolean>((resolve) => {
      child.once("close", (code) => resolve(code === 0));
    });
    const stop = () => {
      this.retired = true;
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
    };
    child.once("error", stop);

    const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
    signal?.addEventListener("abort", stop, { once: true });
    const sent = finished(child.stdin, { readable: false, cleanup: true });
    const received = readOneFrame(child.stdout, responseLimit);
    child.stdin.end(request);
    try {
      const [frame, cleanExit] = await Promise.all([received, exited, sent]);
      if (
        !cleanExit ||
        this.retired ||
        signal?.aborted ||
        performance.now() >= deadline
      ) {
        throw new Error("XLSX_DECODER_UNAVAILABLE");
      }
      const result = decodeResult(frame, job);
      if (performance.now() >= deadline)
        throw new Error("XLSX_DECODER_UNAVAILABLE");
      return result;
    } catch {
      // An incomplete exchange cannot establish that the remote worker settled.
      stop();
      await exited;
      throw new Error("XLSX_DECODER_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
}
