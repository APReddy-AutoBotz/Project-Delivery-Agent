import { spawn, type ChildProcess } from "node:child_process";
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

const bridgeCloseGraceMs = 1_000;

function validIdentity(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < 0xffff_ffff;
}

export class IsolatedXlsxDecoder implements XlsxPreviewDecoder {
  private readonly options: DecoderOptions;
  private reserved = false;
  private retired = false;
  private activeBridge?: ChildProcess;

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
    if (this.reserved || this.retired || this.activeBridge) return null;
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
    signal?.throwIfAborted();
    if (performance.now() >= deadline)
      throw new Error("XLSX_DECODER_UNAVAILABLE");

    const child = spawn(bridge, [socket, String(peerUid), String(peerGid)], {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.activeBridge = child;
    const exited = new Promise<boolean>((resolve) => {
      child.once("close", (code) => {
        this.activeBridge = undefined;
        resolve(code === 0);
      });
    });
    const interruption = new AbortController();
    const unavailable = new Error("XLSX_DECODER_UNAVAILABLE");
    const interrupted = new Promise<never>((_resolve, reject) => {
      interruption.signal.addEventListener("abort", () => reject(unavailable), {
        once: true,
      });
    });
    const stop = () => {
      if (interruption.signal.aborted) return;
      this.retired = true;
      interruption.abort();
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
    };
    child.on("error", stop);

    const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
    signal?.addEventListener("abort", stop, { once: true });
    const sent = finished(child.stdin, { readable: false, cleanup: true });
    const received = readOneFrame(child.stdout, responseLimit);
    try {
      if (signal?.aborted || performance.now() >= deadline) stop();
      else child.stdin.end(request);
      const [frame, cleanExit] = await Promise.race([
        Promise.all([received, exited, sent]),
        interrupted,
      ]);
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
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, bridgeCloseGraceMs);
          }),
        ]);
      } finally {
        clearTimeout(graceTimer);
      }
      // Keep the handle accounted for and the instance retired if close is late.
      if (this.activeBridge) child.unref();
      throw unavailable;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
}
