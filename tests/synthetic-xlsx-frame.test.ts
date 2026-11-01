import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { encodeSyntheticXlsxRequest, encodeSyntheticXlsxResponse, SyntheticXlsxFrameDecoder } from "../packages/domain/src/synthetic-xlsx-frame.js";

const job = "a".repeat(32), generation = "b".repeat(32), expected = { job, generation };
const request = { ...expected, parser: "synthetic.v1", sheet: "Sheet Ω" };
const response = { ...expected, status: "OK" };
const rejected = { ...expected, status: "REJECTED" };
const frame = (header: string | Uint8Array, payload: number[] = []) => {
  const bytes = typeof header === "string" ? new TextEncoder().encode(header) : header;
  const result = new Uint8Array(4 + bytes.length + payload.length);
  new DataView(result.buffer).setUint32(0, bytes.length); result.set(bytes, 4); result.set(payload, 4 + bytes.length);
  return result;
};
const decode = (kind: "request" | "response", bytes: Uint8Array) => {
  const decoder = new SyntheticXlsxFrameDecoder(kind, kind === "response" ? expected : undefined);
  decoder.push(bytes); return decoder.finish();
};

it("matches independent fixed request, success and rejection vectors", () => {
  const req = encodeSyntheticXlsxRequest(request, Uint8Array.of(0, 255, 1));
  const ok = encodeSyntheticXlsxResponse(response, Uint8Array.of(7, 8));
  const no = encodeSyntheticXlsxResponse(rejected, new Uint8Array());
  expect(Buffer.from(req).toString("hex")).toBe("000000845b22706461612e73796e7468657469632e786c73782e726571756573742e7631222c226161616161616161616161616161616161616161616161616161616161616161222c226262626262626262626262626262626262626262626262626262626262626262222c2273796e7468657469632e7631222c22536865657420cea9222c335d00ff01");
  expect(Buffer.from(ok).toString("hex")).toBe("000000705b22706461612e73796e7468657469632e786c73782e726573706f6e73652e7631222c226161616161616161616161616161616161616161616161616161616161616161222c226262626262626262626262626262626262626262626262626262626262626262222c224f4b222c325d0708");
  expect(Buffer.from(no).toString("hex")).toBe("000000765b22706461612e73796e7468657469632e786c73782e726573706f6e73652e7631222c226161616161616161616161616161616161616161616161616161616161616161222c226262626262626262626262626262626262626262626262626262626262626262222c2252454a4543544544222c305d");
  expect(decode("request", req)).toEqual({ kind: "request", header: request, payload: Uint8Array.of(0, 255, 1) });
  expect(decode("response", ok)).toEqual({ kind: "response", header: response, payload: Uint8Array.of(7, 8) });
  expect(decode("response", no)).toEqual({ kind: "response", header: rejected, payload: new Uint8Array() });
});

it("accepts every split, including inside UTF-8, and returns only after EOF", () => {
  const encoded = encodeSyntheticXlsxRequest(request, Uint8Array.of(0, 255, 1));
  for (let split = 0; split <= encoded.length; split++) {
    const decoder = new SyntheticXlsxFrameDecoder("request");
    expect(decoder.push(encoded.slice(0, split))).toBeUndefined();
    expect(decoder.push(new Uint8Array())).toBeUndefined();
    expect(decoder.push(encoded.slice(split))).toBeUndefined();
    expect(decoder.finish()).toEqual({ kind: "request", header: request, payload: Uint8Array.of(0, 255, 1) });
    expect(() => decoder.finish()).toThrow(/^INVALID_INPUT$/);
    expect(() => decoder.push(new Uint8Array())).toThrow(/^INVALID_INPUT$/);
  }
  const decoder = new SyntheticXlsxFrameDecoder("request");
  for (const byte of encoded) decoder.push(Uint8Array.of(byte));
  expect(decoder.finish().payload).toEqual(Uint8Array.of(0, 255, 1));
});

it.each([
  [response, Uint8Array.of(7, 8)],
  [rejected, new Uint8Array()],
])("accepts every split of a correlated response, including empty rejection", (header, payload) => {
  const encoded = encodeSyntheticXlsxResponse(header, payload);
  for (let split = 0; split <= encoded.length; split++) {
    const identity = { ...expected }, decoder = new SyntheticXlsxFrameDecoder("response", identity);
    identity.generation = "c".repeat(32);
    expect(decoder.push(encoded.slice(0, split))).toBeUndefined();
    expect(decoder.push(encoded.slice(split))).toBeUndefined();
    expect(decoder.finish()).toEqual({ kind: "response", header, payload });
  }
});

it("handles deterministic fragmented binary bodies without interpreting their content", () => {
  const body = Uint8Array.from({ length: 4096 }, (_, index) => (index * 37) % 256);
  const encoded = encodeSyntheticXlsxRequest(request, body);
  for (const seed of [1, 7, 19, 73]) {
    const decoder = new SyntheticXlsxFrameDecoder("request"); let cursor = 0, state = seed;
    while (cursor < encoded.length) {
      state = (state * 48271) % 2_147_483_647;
      const end = Math.min(encoded.length, cursor + 1 + state % 83);
      decoder.push(encoded.subarray(cursor, end)); cursor = end;
    }
    expect(decoder.finish().payload).toEqual(body);
  }
});

it("rejects every truncated prefix and any trailing or concatenated frame", () => {
  const encoded = encodeSyntheticXlsxRequest(request, Uint8Array.of(0, 1, 2));
  for (let length = 0; length < encoded.length; length++) {
    const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(encoded.slice(0, length));
    expect(() => decoder.finish()).toThrow(/^INVALID_INPUT$/);
  }
  for (const extra of [Uint8Array.of(0), encoded]) {
    const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(encoded);
    expect(() => decoder.push(extra)).toThrow(/^INVALID_INPUT$/);
    expect(() => decoder.finish()).toThrow(/^INVALID_INPUT$/);
  }
  const combined = new Uint8Array(encoded.length * 2); combined.set(encoded); combined.set(encoded, encoded.length);
  expect(() => decode("request", combined)).toThrow(/^INVALID_INPUT$/);
  const binary = Uint8Array.from([...encoded]);
  const wrapped = encodeSyntheticXlsxRequest(request, binary);
  expect(decode("request", wrapped).payload).toEqual(binary);
});

it("rejects invalid prefixes, UTF-8, noncanonical JSON, schema and stale correlation", () => {
  const req = ["pdaa.synthetic.xlsx.request.v1", job, generation, "synthetic.v1", "Sheet Ω", 1];
  const good = JSON.stringify(req);
  const rawCases = [
    new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 255, 255, 255]),
    frame(Uint8Array.of(0xff)), frame(Uint8Array.of(0xc0, 0x80)),
    frame(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(good)]), [1]),
    frame(new Uint8Array(4096).fill(32)), new Uint8Array([0, 0, 16, 1]),
    frame(" " + good, [1]), frame(good.replace("Sheet Ω", "Sheet \\u03a9"), [1]),
    frame(JSON.stringify([...req, "extra"]), [1]), frame(JSON.stringify({ request: req }), [1]),
    frame(JSON.stringify(["wrong", ...req.slice(1)]), [1]), frame(JSON.stringify([...req.slice(0, 4), "\ud800", 1]), [1]),
    frame(JSON.stringify([...req.slice(0, 5), 0]), []), frame(JSON.stringify([...req.slice(0, 5), 1_048_577]), []),
  ];
  for (const value of rawCases) {
    const decoder = new SyntheticXlsxFrameDecoder("request");
    expect(() => { decoder.push(value); decoder.finish(); }).toThrow(/^INVALID_INPUT$/);
    expect(() => decoder.push(Uint8Array.of(1))).toThrow(/^INVALID_INPUT$/);
  }
  const stale = encodeSyntheticXlsxResponse({ ...response, generation: "c".repeat(32) }, Uint8Array.of(1));
  expect(() => decode("response", stale)).toThrow(/^INVALID_INPUT$/);
  const wrongJob = encodeSyntheticXlsxResponse({ ...response, job: "c".repeat(32) }, Uint8Array.of(1));
  expect(() => decode("response", wrongJob)).toThrow(/^INVALID_INPUT$/);
  const invalidStatus = frame(JSON.stringify(["pdaa.synthetic.xlsx.response.v1", job, generation, "REJECTED", 1]), [1]);
  expect(() => decode("response", invalidStatus)).toThrow(/^INVALID_INPUT$/);
  const negativeZero = frame(`["pdaa.synthetic.xlsx.response.v1","${job}","${generation}","REJECTED",-0]`);
  expect(() => decode("response", negativeZero)).toThrow(/^INVALID_INPUT$/);
});

it("bounds payloads and ingress work and makes detached copies", () => {
  expect(() => encodeSyntheticXlsxRequest(request, new Uint8Array())).toThrow(/^INVALID_INPUT$/);
  expect(() => encodeSyntheticXlsxRequest(request, new Uint8Array(1_048_577))).toThrow(/^INVALID_INPUT$/);
  expect(() => encodeSyntheticXlsxResponse(response, new Uint8Array(4_194_305))).toThrow(/^INVALID_INPUT$/);
  expect(() => encodeSyntheticXlsxResponse(rejected, Uint8Array.of(1))).toThrow(/^INVALID_INPUT$/);
  expect(decode("request", encodeSyntheticXlsxRequest(request, new Uint8Array(1_048_576))).payload.length).toBe(1_048_576);
  expect(decode("response", encodeSyntheticXlsxResponse(response, new Uint8Array(4_194_304))).payload.length).toBe(4_194_304);
  const source = Uint8Array.of(4, 5, 6), encoded = encodeSyntheticXlsxRequest(request, source);
  source.fill(0); const decoder = new SyntheticXlsxFrameDecoder("request");
  decoder.push(encoded); encoded.fill(0);
  const result = decoder.finish(); expect(result.payload).toEqual(Uint8Array.of(4, 5, 6));
  result.payload.fill(0); expect(source).toEqual(Uint8Array.of(0, 0, 0));
  const many = encodeSyntheticXlsxRequest(request, new Uint8Array(65_536));
  const tiny = new SyntheticXlsxFrameDecoder("request");
  expect(() => { for (const byte of many) tiny.push(Uint8Array.of(byte)); }).toThrow(/^INVALID_INPUT$/);
  expect(() => tiny.finish()).toThrow(/^INVALID_INPUT$/);
});

it("rejects accessors and keeps errors free of sensitive synthetic values", () => {
  const canary = "private-synthetic-value", hostile = { ...request, get sheet() { throw new Error(canary); } };
  expect(() => encodeSyntheticXlsxRequest(hostile, Uint8Array.of(1))).toThrow(/^INVALID_INPUT$/);
  const decoder = new SyntheticXlsxFrameDecoder("request");
  try { decoder.push(frame(JSON.stringify(["wrong", canary]), [1])); } catch (error) { expect(String(error)).not.toContain(canary); }
});

it("uses intrinsic byte views rather than overridden typed-array accessors or species", () => {
  const canary = "private-typed-array-error", encoded = encodeSyntheticXlsxRequest(request, Uint8Array.of(3, 4));
  class Hostile extends Uint8Array {}
  Object.defineProperty(Hostile, Symbol.species, { get() { throw new Error(canary); } });
  const value = new Hostile(encoded);
  for (const key of ["buffer", "byteLength", "byteOffset", "length", "subarray", "slice"])
    Object.defineProperty(value, key, { get() { throw new Error(canary); } });
  const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(value);
  expect(decoder.finish().payload).toEqual(Uint8Array.of(3, 4));
  const payload = new Hostile([8, 9]);
  Object.defineProperty(payload, "byteLength", { get() { throw new Error(canary); } });
  expect(decode("request", encodeSyntheticXlsxRequest(request, payload)).payload).toEqual(Uint8Array.of(8, 9));
  const proxy = new Proxy(new Uint8Array([1]), { get() { throw new Error(canary); } });
  const failed = new SyntheticXlsxFrameDecoder("request");
  try { failed.push(proxy); throw new Error("Expected failure"); } catch (error) { expect(String(error)).toContain("INVALID_INPUT"); expect(String(error)).not.toContain(canary); }
  expect(() => failed.finish()).toThrow(/^INVALID_INPUT$/);
});

it("rejects shared or detached input and bounds empty pushes", () => {
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    expect(() => encodeSyntheticXlsxRequest(request, shared)).toThrow(/^INVALID_INPUT$/);
    const decoder = new SyntheticXlsxFrameDecoder("request");
    expect(() => decoder.push(shared)).toThrow(/^INVALID_INPUT$/);
    expect(() => decoder.finish()).toThrow(/^INVALID_INPUT$/);
    const foreign = new Uint8Array(runInNewContext("new SharedArrayBuffer(2)") as SharedArrayBuffer);
    expect(() => encodeSyntheticXlsxRequest(request, foreign)).toThrow(/^INVALID_INPUT$/);
    const foreignDecoder = new SyntheticXlsxFrameDecoder("request");
    expect(() => foreignDecoder.push(foreign)).toThrow(/^INVALID_INPUT$/);
    expect(() => foreignDecoder.finish()).toThrow(/^INVALID_INPUT$/);
  }
  const detached = Uint8Array.of(1); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  expect(() => encodeSyntheticXlsxRequest(request, detached)).toThrow(/^INVALID_INPUT$/);
  const empty = new SyntheticXlsxFrameDecoder("request");
  for (let index = 0; index < 65_536; index++) empty.push(new Uint8Array());
  expect(() => empty.push(new Uint8Array())).toThrow(/^INVALID_INPUT$/);
  expect(() => empty.finish()).toThrow(/^INVALID_INPUT$/);
});

it("sanitizes exceptions from reflective header and correlation traps", () => {
  const canary = "private-proxy-canary";
  const traps = [
    { getPrototypeOf() { throw new Error(canary); } },
    { ownKeys() { throw new Error(canary); } },
    { getOwnPropertyDescriptor() { throw new Error(canary); } },
  ];
  for (const handler of traps) {
    for (const operation of [
      () => encodeSyntheticXlsxRequest(new Proxy({ ...request }, handler), Uint8Array.of(1)),
      () => encodeSyntheticXlsxResponse(new Proxy({ ...response }, handler), Uint8Array.of(1)),
      () => new SyntheticXlsxFrameDecoder("response", new Proxy({ ...expected }, handler)),
    ]) {
      try { operation(); throw new Error("Expected rejection"); }
      catch (error) { expect(String(error)).toContain("INVALID_INPUT"); expect(String(error)).not.toContain(canary); }
    }
  }
});

it("copies nonzero-offset Node buffers without exposing their backing storage", () => {
  const encoded = encodeSyntheticXlsxRequest(request, Uint8Array.of(2, 3));
  const wrapped = Buffer.concat([Buffer.from([99, 99]), Buffer.from(encoded), Buffer.from([88])]);
  const view = wrapped.subarray(2, -1), decoder = new SyntheticXlsxFrameDecoder("request");
  decoder.push(view); wrapped.fill(0);
  expect(decoder.finish().payload).toEqual(Uint8Array.of(2, 3));
});
