import { IngestionInputError } from "./connector.js";

// Synthetic framing only: no socket, liveness, peer authentication, parser
// isolation, authorization, workbook fidelity or receipt is established.
const headerLimit = 4096, requestLimit = 1_048_576, responseLimit = 4_194_304, chunkLimit = 65_536;
const requestTag = "pdaa.synthetic.xlsx.request.v1", responseTag = "pdaa.synthetic.xlsx.response.v1";
const encoder = new TextEncoder();
const invalid = (): never => { throw new IngestionInputError("INVALID_INPUT"); };
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
const sheet = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value);
type RequestHeader = { job: string; generation: string; parser: string; sheet: string };
type ResponseHeader = { job: string; generation: string; status: "OK" | "REJECTED" };
type Expected = { job: string; generation: string };
type Result = { kind: "request"; header: RequestHeader; payload: Uint8Array } |
  { kind: "response"; header: ResponseHeader; payload: Uint8Array };

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result[key] = descriptor.value;
  }
  return result;
  } catch { return invalid(); }
}
function ids(input: Record<string, unknown>): Expected {
  if (!id(input.job) || !id(input.generation)) return invalid();
  return { job: input.job, generation: input.generation };
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const getArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
function plainView(input: unknown): Uint8Array {
  try {
    if (!(input instanceof Uint8Array)) return invalid();
    const length = getLength.call(input), offset = getOffset.call(input), buffer = getBuffer.call(input);
    // The ArrayBuffer intrinsic accepts cross-realm ArrayBuffers but rejects
    // SharedArrayBuffer regardless of the realm in which it was created.
    getArrayBufferLength.call(buffer);
    return new Uint8Array(buffer, offset, length);
  } catch { return invalid(); }
}
function payloadCopy(input: unknown, min: number, max: number): Uint8Array {
  const view = plainView(input);
  if (view.length < min || view.length > max) return invalid();
  const result = new Uint8Array(view.length); result.set(view); return result;
}
function build(tuple: unknown[], payload: Uint8Array): Uint8Array {
  const header = encoder.encode(JSON.stringify(tuple));
  if (!header.length || header.length > headerLimit) return invalid();
  const result = new Uint8Array(4 + header.length + payload.length);
  new DataView(result.buffer).setUint32(0, header.length, false);
  result.set(header, 4); result.set(payload, 4 + header.length);
  return result;
}
export function encodeSyntheticXlsxRequest(input: unknown, bytes: unknown): Uint8Array {
  const value = object(input, ["job", "generation", "parser", "sheet"]), identity = ids(value);
  if (!token(value.parser) || !sheet(value.sheet)) return invalid();
  const payload = payloadCopy(bytes, 1, requestLimit);
  return build([requestTag, identity.job, identity.generation, value.parser, value.sheet, payload.length], payload);
}
export function encodeSyntheticXlsxResponse(input: unknown, bytes: unknown): Uint8Array {
  const value = object(input, ["job", "generation", "status"]), identity = ids(value);
  if (value.status !== "OK" && value.status !== "REJECTED") return invalid();
  const payload = payloadCopy(bytes, value.status === "OK" ? 1 : 0, value.status === "OK" ? responseLimit : 0);
  return build([responseTag, identity.job, identity.generation, value.status, payload.length], payload);
}

// One complete frame per half-closed stream. No value is returned before EOF;
// callers must supply their own deadlines, cancellation and resource admission.
export class SyntheticXlsxFrameDecoder {
  private readonly prefix = new Uint8Array(4);
  private prefixLength = 0;
  private headerBytes?: Uint8Array;
  private headerLength = 0;
  private body?: Uint8Array;
  private bodyLength = 0;
  private parsed?: { kind: "request"; header: RequestHeader } | { kind: "response"; header: ResponseHeader };
  private closed = false;
  private chunks = 0;
  private readonly expected?: Expected;

  constructor(private readonly kind: "request" | "response", expected?: unknown) {
    if (kind !== "request" && kind !== "response") return invalid();
    if (kind === "response") this.expected = ids(object(expected, ["job", "generation"]));
    else if (expected !== undefined) return invalid();
  }
  private fail(): never { this.closed = true; this.headerBytes = undefined; this.body = undefined; this.parsed = undefined; return invalid(); }
  private parseHeader(): void {
    try {
      const bytes = this.headerBytes!;
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(decoded);
      const canonical = encoder.encode(JSON.stringify(value));
      if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]) || !Array.isArray(value)) return this.fail();
      let length: unknown;
      if (this.kind === "request") {
        if (value.length !== 6 || value[0] !== requestTag || !id(value[1]) || !id(value[2]) || !token(value[3]) || !sheet(value[4])) return this.fail();
        length = value[5];
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > requestLimit) return this.fail();
        this.parsed = { kind: "request", header: { job: value[1], generation: value[2], parser: value[3], sheet: value[4] } };
      } else {
        if (value.length !== 5 || value[0] !== responseTag || !id(value[1]) || !id(value[2]) ||
            value[1] !== this.expected!.job || value[2] !== this.expected!.generation ||
            (value[3] !== "OK" && value[3] !== "REJECTED")) return this.fail();
        length = value[4];
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > responseLimit ||
            (value[3] === "OK" ? length < 1 : length !== 0) || Object.is(length, -0)) return this.fail();
        this.parsed = { kind: "response", header: { job: value[1], generation: value[2], status: value[3] } };
      }
      this.body = new Uint8Array(length);
    } catch { return this.fail(); }
  }
  push(input: unknown): void {
    if (this.closed) return invalid();
    if (++this.chunks > chunkLimit) return this.fail();
    let view: Uint8Array;
    try { view = plainView(input); } catch { return this.fail(); }
    if (!view.length) return;
    try {
    const buffer = getBuffer.call(view), base = getOffset.call(view);
    let offset = 0;
    while (offset < view.length) {
      if (this.prefixLength < 4) {
        const take = Math.min(4 - this.prefixLength, view.length - offset);
        this.prefix.set(new Uint8Array(buffer, base + offset, take), this.prefixLength); this.prefixLength += take; offset += take;
        if (this.prefixLength === 4) {
          const length = new DataView(this.prefix.buffer).getUint32(0, false);
          if (!length || length > headerLimit) return this.fail();
          this.headerBytes = new Uint8Array(length);
        }
      } else if (this.headerLength < this.headerBytes!.length) {
        const take = Math.min(this.headerBytes!.length - this.headerLength, view.length - offset);
        this.headerBytes!.set(new Uint8Array(buffer, base + offset, take), this.headerLength); this.headerLength += take; offset += take;
        if (this.headerLength === this.headerBytes!.length) this.parseHeader();
      } else {
        if (!this.body || this.bodyLength === this.body.length) return this.fail();
        const take = Math.min(this.body.length - this.bodyLength, view.length - offset);
        this.body.set(new Uint8Array(buffer, base + offset, take), this.bodyLength); this.bodyLength += take; offset += take;
      }
    }
    } catch { return this.fail(); }
  }
  finish(): Result {
    if (this.closed) return invalid();
    if (this.prefixLength !== 4 || !this.headerBytes || this.headerLength !== this.headerBytes.length ||
        !this.parsed || !this.body || this.bodyLength !== this.body.length) return this.fail();
    this.closed = true;
    const result = { ...this.parsed, payload: this.body } as Result;
    this.headerBytes = undefined; this.body = undefined; this.parsed = undefined;
    return result;
  }
}
