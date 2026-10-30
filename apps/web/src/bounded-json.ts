// A bounded preview must not buffer an unbounded response before validation.
export async function readBoundedJson(response: Response, limit: number, onUnavailable: () => void = () => {}): Promise<unknown> {
  if (!response.body || !Number.isInteger(limit) || limit < 1) throw new Error("Response unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    try { onUnavailable(); } catch { /* Keep failures generic and finish the discard. */ }
    try { await reader.cancel(); } catch { /* A failed discard remains a generic error. */ }
    throw new Error("Response unavailable");
  } finally { reader.releaseLock(); }
}

// Drain without retaining bytes so the existing disclosure recorder can observe
// complete denial bodies. The caller holds its request lease until this settles.
export async function discardResponse(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try { while (!(await reader.read()).done) { /* Discard each chunk immediately. */ } }
  catch { /* The request remains unavailable. */ }
  finally { reader.releaseLock(); }
}
