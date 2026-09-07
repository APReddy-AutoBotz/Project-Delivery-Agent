import { expect, it, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { operationalLog } from "../packages/platform/src/index.js";

it("SEC-SECRET-001: logs retain known diagnostic fields and discard unexpected values at runtime", () => {
  const canary = randomBytes(32).toString("hex");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const correlationId = randomUUID();
    operationalLog("http.request", {
      correlationId,
      method: "GET",
      status: 200,
      durationMs: 7,
      token: canary,
      password: canary,
      error: new Error(canary),
      event: canary,
      timestamp: canary,
    } as never);
    operationalLog(canary, {
      correlationId: canary,
      method: canary,
      status: canary,
      durationMs: canary,
    } as never);
    operationalLog("worker.start_failed.startup.connection_timeout");
    operationalLog("worker.start_failed." + canary);
    operationalLog("http.request", { status: 700, durationMs: Infinity });
    let reads = 0;
    operationalLog("http.request", {
      get method() {
        return ++reads < 3 ? "GET" : canary;
      },
    });
    const messages = output.mock.calls.map(([text]) => JSON.parse(text));
    expect(messages).toHaveLength(6);
    expect(reads).toBe(0);
    expect(messages[5]).toEqual({
      timestamp: expect.any(String),
      event: "http.request",
    });
    expect(messages[0]).toEqual({
      timestamp: expect.any(String),
      event: "http.request",
      correlationId,
      method: "GET",
      status: 200,
      durationMs: 7,
    });
    expect(messages[1]).toEqual({
      timestamp: expect.any(String),
      event: "operational.invalid_event",
    });
    expect(messages[2].event).toBe(
      "worker.start_failed.startup.connection_timeout",
    );
    expect(messages[3].event).toBe("operational.invalid_event");
    expect(messages[4]).toEqual({
      timestamp: expect.any(String),
      event: "http.request",
    });
    expect(JSON.stringify(messages).includes(canary)).toBe(false);
  } finally {
    output.mockRestore();
  }
});
