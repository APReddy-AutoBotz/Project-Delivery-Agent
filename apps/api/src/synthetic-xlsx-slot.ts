import { randomBytes } from "node:crypto";

// Internal experiment for FR-CON-006/007. Adapters must be trusted, cooperative
// JavaScript. This is not a parser, upload endpoint, supervisor or isolation boundary.
type FrameResult = { kind: "response"; header: { status: "OK" | "REJECTED" }; payload: Uint8Array };
type Decoder = { push(chunk: unknown): void; finish(): FrameResult };
type Codec = {
  encode(header: { job: string; generation: string; parser: string; sheet: string }, bytes: Uint8Array): Uint8Array;
  response(expected: { job: string; generation: string }): Decoder;
};
type Port = {
  exchange(frame: Uint8Array, signal: AbortSignal): AsyncIterable<unknown>;
  // A trusted adapter must acknowledge exactly the broker-selected next generation.
  reset(previous: string, next: string): Promise<string>;
};
type Input = {
  length: number;
  parser: string;
  sheet: string;
  chunks: AsyncIterable<unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
};
type Job = {
  input: Input;
  deadline: number;
  controller: AbortController;
  resolve: (value: Uint8Array) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
  settled: boolean;
  active: boolean;
};

const INPUT_LIMIT = 1_048_576;
const CHUNK_LIMIT = 65_536;
const COUNTER_MAX = 0xffff_ffff_ffff_ffffn;
const failure = () => new Error("XLSX_SLOT_UNAVAILABLE");
const arrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(arrayProto, "buffer")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(arrayProto, "byteOffset")!.get!;
const getLength = Object.getOwnPropertyDescriptor(arrayProto, "byteLength")!.get!;
const getArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;

function view(input: unknown): Uint8Array {
  try {
    if (!(input instanceof Uint8Array)) throw failure();
    const buffer = getBuffer.call(input), offset = getOffset.call(input), length = getLength.call(input);
    getArrayBufferLength.call(buffer); // Reject SharedArrayBuffer, including foreign-realm instances.
    return new Uint8Array(buffer, offset, length); // Reject detached buffers.
  } catch { throw failure(); }
}

export class SyntheticXlsxSlot {
  private readonly prefix = randomBytes(8).toString("hex");
  private counter = 0n;
  private generation = this.nextId();
  private readonly queue: Job[] = [];
  private active?: Job;
  private reserved = 0;
  private state: "IDLE" | "LEASED" | "QUARANTINED" | "RESETTING" | "CLOSED" = "IDLE";

  constructor(private readonly codec: Codec, private readonly port: Port,
    private readonly maxJobs: number, private readonly maxReserved: number) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 32 ||
        !Number.isSafeInteger(maxReserved) || maxReserved < 1 || maxReserved > 32 * INPUT_LIMIT) throw failure();
  }

  private nextId(): string {
    if (this.counter >= COUNTER_MAX) throw failure();
    this.counter += 1n;
    return this.prefix + this.counter.toString(16).padStart(16, "0");
  }

  private closed(): boolean { return this.state === "CLOSED"; }

  // Diagnostic counts expose no workbook, sheet, job or generation values.
  snapshot(): { state: string; jobs: number; reserved: number } {
    return { state: this.state, jobs: this.queue.length + (this.active ? 1 : 0), reserved: this.reserved };
  }

  submit(input: Input): Promise<Uint8Array> {
    try {
      // Keep accounting and frame metadata stable even if the caller mutates its object.
      const request: Input = { length: input.length, timeoutMs: input.timeoutMs, parser: input.parser,
        sheet: input.sheet, chunks: input.chunks, signal: input.signal };
      if (this.state === "CLOSED" || !Number.isSafeInteger(request.length) || request.length < 1 || request.length > INPUT_LIMIT ||
          !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000 ||
          request.signal?.aborted || this.queue.length + (this.active ? 1 : 0) >= this.maxJobs ||
          request.length > this.maxReserved - this.reserved) throw failure();
      // The injected codec validates the parser token and exact sheet before admission.
      this.codec.encode({ job: "0".repeat(32), generation: "0".repeat(32), parser: request.parser, sheet: request.sheet }, Uint8Array.of(1));
      const deadline = performance.now() + request.timeoutMs;
      this.reserved += request.length;
      return new Promise((resolve, reject) => {
        const job: Job = { input: request, deadline, controller: new AbortController(), resolve, reject,
          timer: setTimeout(() => this.cancel(job), request.timeoutMs), settled: false, active: false };
        if (request.signal) {
          job.abort = () => this.cancel(job);
          request.signal.addEventListener("abort", job.abort, { once: true });
        }
        this.queue.push(job);
        if (request.signal?.aborted) this.cancel(job); else this.pump();
      });
    } catch { return Promise.reject(failure()); }
  }

  private settle(job: Job, value?: Uint8Array): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (job.abort) job.input.signal?.removeEventListener("abort", job.abort);
    if (value) job.resolve(value); else job.reject(failure());
  }

  private cancel(job: Job): void {
    if (job.settled) return;
    job.controller.abort();
    this.settle(job);
    if (!job.active) {
      const index = this.queue.indexOf(job);
      if (index !== -1) { this.queue.splice(index, 1); this.reserved -= job.input.length; }
    } else if (this.state !== "CLOSED") this.state = "QUARANTINED";
  }

  private check(job: Job): void {
    if (job.settled || this.state === "CLOSED" || performance.now() >= job.deadline) {
      this.cancel(job);
      throw failure();
    }
  }

  private pump(): void {
    if (this.state !== "IDLE") return;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      if (performance.now() >= job.deadline) { this.reserved -= job.input.length; this.settle(job); continue; }
      this.active = job; job.active = true; this.state = "LEASED";
      void this.run(job);
      return;
    }
  }

  private async run(job: Job): Promise<void> {
    const generation = this.generation;
    try {
      const id = this.nextId();
      const bytes = new Uint8Array(job.input.length);
      let length = 0, calls = 0;
      for await (const item of job.input.chunks) {
        this.check(job);
        if (++calls > CHUNK_LIMIT) throw failure();
        const chunk = view(item);
        if (chunk.length > bytes.length - length) throw failure();
        bytes.set(chunk, length); length += chunk.length;
      }
      this.check(job);
      if (length !== bytes.length) throw failure();
      const frame = this.codec.encode({ job: id, generation, parser: job.input.parser, sheet: job.input.sheet }, bytes);
      const decoder = this.codec.response({ job: id, generation });
      for await (const chunk of this.port.exchange(frame, job.controller.signal)) {
        this.check(job);
        decoder.push(chunk);
      }
      this.check(job);
      const result = decoder.finish();
      this.check(job);
      if (result.kind !== "response" || result.header.status !== "OK") throw failure();
      this.settle(job, result.payload);
    } catch { this.settle(job); }
    // No reuse while any awaited producer, exchange, iterator cleanup or reset is pending.
    if (this.state === "CLOSED") return;
    this.state = "QUARANTINED";
    try {
      const next = this.nextId();
      this.state = "RESETTING";
      const acknowledged = await this.port.reset(generation, next);
      if (this.closed()) return;
      if (acknowledged !== next) throw failure();
      this.generation = next;
      this.reserved -= job.input.length;
      this.active = undefined;
      this.state = "IDLE";
      this.pump();
    } catch {
      if (!this.closed()) this.state = "QUARANTINED";
    }
  }

  close(): void {
    if (this.state === "CLOSED") return;
    this.state = "CLOSED";
    if (this.active) this.cancel(this.active);
    for (const job of [...this.queue]) this.cancel(job);
  }
}
