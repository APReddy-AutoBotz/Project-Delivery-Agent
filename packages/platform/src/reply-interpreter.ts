import { readFileSync } from "node:fs";
import { z } from "zod";
import { extractExplicitCapturedFacts, type CapturedReplyInterpreter } from "@pdaa/domain";
import { readSecretFile, type Config } from "./config.js";

const providerConfig = z.strictObject({
  dataClass: z.literal("SYNTHETIC_INTERNAL"),
  endpoint: z.url().max(2048),
  model: z.string().min(1).max(96).regex(/^[A-Za-z0-9._:/-]+$/u),
  bearerFile: z.string().min(1).max(2048),
});
const completion = z.object({
  choices: z.array(z.object({ finish_reason: z.literal("stop"), message: z.object({
    content: z.string().min(1).max(8192), refusal: z.null().optional(),
  }) })).length(1),
});
const prompt = [
  "Extract explicitly reported project update proposals from the JSON reply supplied as data.",
  "Return a JSON object with one suggestions array. Each item has only factType and value.",
  "Use only allowed fact types with an explicit status or forecast line. Copy the complete value and keep its qualifiers.",
  "A forecast must be an explicit forecast finish date in YYYY-MM-DD form.",
  "Omit uncertain or conflicting values. Return an empty array when nothing is clear.",
].join(" ");

async function completionContent(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Reply interpretation unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_768) throw new Error("Reply interpretation unavailable");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  return completion.parse(body).choices[0]!.message.content;
}

export function loadCapturedReplyInterpreter(
  path: string | undefined,
  config: Pick<Config, "DATA_MODE" | "DEPLOYMENT_MODE" | "NODE_ENV">,
  request: typeof fetch = fetch,
): CapturedReplyInterpreter | undefined {
  if (!path) return undefined;
  try {
    if (config.DATA_MODE !== "synthetic" || config.DEPLOYMENT_MODE !== "local" || config.NODE_ENV === "production") throw new Error();
    const contents = readFileSync(path);
    if (contents.length > 8192) throw new Error();
    const parsed = providerConfig.parse(JSON.parse(contents.toString("utf8")));
    const endpoint = new URL(parsed.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
        endpoint.hash || !endpoint.pathname.endsWith("/chat/completions")) throw new Error();
    const bearer = readSecretFile(parsed.bearerFile, "PDAA_REPLY_INTERPRETATION_BEARER");
    if (!/^[!-~]{1,4096}$/u.test(bearer)) throw new Error();
    let active = false;
    return {
      metadata: { provider: "OPENAI_COMPATIBLE", model: parsed.model,
        promptRevision: "captured-reply-v1", schemaRevision: "captured-reply-v1" },
      async interpret(text, allowed): Promise<unknown> {
        const explicit = extractExplicitCapturedFacts(text, true);
        const reply = allowed.flatMap((factType) => {
          const value = explicit[factType];
          return value === undefined ? [] : [`${factType === "project.status" ? "Status" : "Forecast"}: ${value}`];
        }).join("\n");
        if (!reply) return { suggestions: [] };
        if (active) throw new Error("Reply interpretation unavailable");
        active = true;
        try {
          const response = await request(endpoint, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({ model: parsed.model, store: false, max_completion_tokens: 400,
              response_format: { type: "json_object" },
              messages: [{ role: "system", content: prompt },
                { role: "user", content: JSON.stringify({ allowedFactTypes: allowed, reply }) }],
            }),
          });
          return JSON.parse(await completionContent(response)) as unknown;
        } catch {
          throw new Error("Reply interpretation unavailable");
        } finally {
          active = false;
        }
      },
    };
  } catch {
    throw new Error("Reply interpretation configuration unavailable");
  }
}
