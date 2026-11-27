import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readGroundedReplySuggestions } from "../packages/domain/src/project-update-capture.js";
import { loadCapturedReplyInterpreter } from "../packages/platform/src/reply-interpreter.js";

const reply = "Status: The integration environment is ready.\nForecast finish remains 2026-12-08.";
const suggestions = [{ factType: "project.forecast", value: "2026-12-08" }] as const;

it("validates the exact supported reply values before returning inference", () => {
  const allowed = ["project.forecast"] as const;
  expect(readGroundedReplySuggestions(reply, allowed, { suggestions })).toEqual(suggestions);
  for (const output of [
    { suggestions: [{ factType: "project.forecast", value: "2026-12-09" }] },
    { suggestions: [{ factType: "project.status", value: "ready" }] },
    { suggestions: [...suggestions, ...suggestions] },
    { suggestions, classification: "HUMAN_CONFIRMED" },
  ]) expect(readGroundedReplySuggestions(reply, allowed, output)).toEqual([]);
  expect(readGroundedReplySuggestions("Status: Integration is not ready.", ["project.status"], {
    suggestions: [{ factType: "project.status", value: "ready" }],
  })).toEqual([]);
  const completeStatus = [{ factType: "project.status", value: "Integration is not ready." }];
  expect(readGroundedReplySuggestions("The project status is Integration is not ready.", ["project.status"], {
    suggestions: completeStatus,
  })).toEqual(completeStatus);
  expect(readGroundedReplySuggestions("Forecast: 2026-12-08 is no longer expected.", allowed, { suggestions })).toEqual([]);
  expect(readGroundedReplySuggestions(reply + "\nForecast: 2026-12-09", allowed, { suggestions })).toEqual([]);
});

it("binds the compatible provider to the operator-configured synthetic endpoint and bounded request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdaa-reply-"));
  const bearerFile = join(directory, "bearer"), configFile = join(directory, "provider.json");
  const endpoint = "https://reply-provider.example.test/v1/chat/completions";
  try {
    await writeFile(bearerFile, "synthetic-provider-bearer\n");
    await writeFile(configFile, JSON.stringify({ dataClass: "SYNTHETIC_INTERNAL", endpoint, model: "fixture-model", bearerFile }));
    const config = { DATA_MODE: "synthetic", DEPLOYMENT_MODE: "local", NODE_ENV: "test" } as const;
    const request = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ suggestions }) } }] }));
    expect(loadCapturedReplyInterpreter(undefined, config, request)).toBeUndefined();
    expect(() => loadCapturedReplyInterpreter(configFile, { ...config, DATA_MODE: "customer" }, request))
      .toThrow("Reply interpretation configuration unavailable");
    const provider = loadCapturedReplyInterpreter(configFile, config, request)!;
    const allowed = ["project.forecast"] as const;
    expect(readGroundedReplySuggestions(reply, allowed, await provider.interpret(reply, allowed))).toEqual(suggestions);
    const [target, init] = request.mock.calls[0]!;
    expect(String(target)).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    const { messages, ...envelope } = JSON.parse(String(init?.body));
    expect(envelope).toEqual({ model: "fixture-model", store: false, max_completion_tokens: 400,
      response_format: { type: "json_object" } });
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[1].content)).toEqual({ allowedFactTypes: allowed, reply });
    request.mockRejectedValueOnce(new DOMException("Synthetic timeout", "TimeoutError"));
    await expect(provider.interpret(reply, allowed)).rejects.toThrow(/^Reply interpretation unavailable$/u);
  } finally {
    await Promise.all([unlink(bearerFile).catch(() => {}), unlink(configFile).catch(() => {})]);
    await rmdir(directory);
  }
});
