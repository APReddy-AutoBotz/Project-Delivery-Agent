import type { ManagedReadEnd } from "./managed-read-registry.js";

// A completion signal describes local body handling, not recorder capture or
// remote completion. Callers that do not manage a slot need not supply one.
type Completion = (end: ManagedReadEnd) => void;
function report(completion: Completion | undefined, end: ManagedReadEnd) {
  try { completion?.(end); } catch { /* Accounting cannot change response behavior. */ }
}
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>, completion: Completion | undefined, end: ManagedReadEnd) {
  try { reader.releaseLock(); }
  catch (error) { report(completion, "unknown"); throw error; }
  report(completion, end);
}

// Preserve the unbounded JSON contract while recording transport completion
// before parsing, so malformed JSON does not look like unfinished cleanup.
export async function readCompleteJson(response: Response, completion: Completion): Promise<unknown> {
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch (error) { report(completion, "unknown"); throw error; }
  if (!body) { report(completion, "unknown"); throw new Error("Response unavailable"); }
  let text: string;
  try { text = await response.text(); }
  catch (error) { report(completion, "unknown"); throw error; }
  report(completion, "eof");
  return JSON.parse(text);
}

// A bounded preview must not buffer an unbounded response before validation.
export async function readBoundedJson(response: Response, limit: number, onUnavailable: () => void = () => {}, completion?: Completion): Promise<unknown> {
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch (error) { report(completion, "unknown"); throw error; }
  if (!body || !Number.isInteger(limit) || limit < 1) { report(completion, "unknown"); throw new Error("Response unavailable"); }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch (error) { report(completion, "unknown"); throw error; }
  const chunks: Uint8Array[] = []; let length = 0;
  let end: ManagedReadEnd = "unknown";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { end = "eof"; break; }
      length += part.value.byteLength;
      if (length > limit) throw new Error();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    try { onUnavailable(); } catch { /* Keep failures generic and finish the discard. */ }
    try { await reader.cancel(); if (end !== "eof") end = "terminated"; }
    catch { /* A failed discard remains a generic error and unknown cleanup. */ }
    throw new Error("Response unavailable");
  } finally { releaseReader(reader, completion, end); }
}

// Read the one original body under an encoded-byte cap. Returning text lets a
// trusted owner privately parse the exact decoded response before publication.
// Report local stream completion only after releasing its reader; EOF does not
// establish disclosure-recorder capture or remote request completion.
export async function readBoundedUtf8Text(response: Response, limit: number, completion: Completion,
  onUnavailable: () => void = () => {}): Promise<string> {
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch (error) { report(completion, "unknown"); throw error; }
  if (!body || !Number.isSafeInteger(limit) || limit < 1) { report(completion, "unknown"); throw new Error("Response unavailable"); }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch (error) { report(completion, "unknown"); throw error; }
  const chunks: Uint8Array[] = []; let length = 0, end: ManagedReadEnd = "unknown";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { end = "eof"; break; }
      if (!(part.value instanceof Uint8Array)) throw new Error("Response unavailable");
      length += part.value.byteLength;
      if (!Number.isSafeInteger(length) || length > limit) throw new Error("Response unavailable");
      if (part.value.byteLength) chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try { onUnavailable(); } catch { /* Physical cleanup must still proceed. */ }
    if (end !== "eof") {
      try { await reader.cancel(); end = "terminated"; }
      catch { /* Cleanup is indeterminate; the managed slot stays occupied. */ }
    }
    throw new Error("Response unavailable");
  } finally { releaseReader(reader, completion, end); }
}

// Drain without retaining bytes so the existing disclosure recorder can observe
// complete denial bodies. The caller holds its request lease until this settles.
export async function discardResponse(response: Response, completion?: Completion): Promise<void> {
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; } catch (error) { report(completion, "unknown"); throw error; }
  // Only HTTP statuses that cannot carry a response body establish local
  // no-body termination here. Null on an opaque/error response is not EOF.
  if (!body) { report(completion, [204, 205, 304].includes(response.status) ? "terminated" : "unknown"); return; }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch (error) { report(completion, "unknown"); throw error; }
  let end: ManagedReadEnd = "unknown";
  try { while (!(await reader.read()).done) { /* Discard each chunk immediately. */ } end = "eof"; }
  catch { /* The request remains unavailable. */ }
  finally { releaseReader(reader, completion, end); }
}
