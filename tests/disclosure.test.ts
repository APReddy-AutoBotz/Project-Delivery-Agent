import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createDisclosureCheck } from "../scripts/acceptance/disclosure.mjs";

it("SEC-SECRET-001: disclosure checks reject leaks in every declared channel without reflecting them", () => {
  const secret = randomBytes(32).toString("base64") + '%+"\n';
  const channels = [
    "stdout",
    "stderr",
    "api-body",
    "api-headers",
    "browser-response-bodies",
    "browser-response-headers",
    "browser-console",
    "browser-errors",
    "browser-dom",
    "browser-storage",
    "assets",
    "configuration",
    "service-logs",
  ];
  for (const channel of channels) {
    for (const value of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ]) {
      const disclosure = createDisclosureCheck([secret]);
      disclosure.add(channel, "synthetic-prefix:" + value);
      expect(() => disclosure.verify([channel])).toThrow(
        /^Secret disclosure detected$/,
      );
    }
  }
});
it("SEC-SECRET-001: disclosure evidence requires nonempty channels and includes late-issued tokens", () => {
  const secret = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("hex");
  expect(() => createDisclosureCheck([])).toThrow();
  const disclosure = createDisclosureCheck([secret]);
  disclosure.add("stdout", "");
  expect(() => disclosure.verify(["stdout"])).toThrow(/empty/);
  disclosure.add("stdout", '{"event":"api.started"}');
  expect(() => disclosure.verify(["stdout", "headers"])).toThrow(/empty/);
  expect(disclosure.verify(["stdout"])).toEqual({
    stdout: { captures: 2, bytes: 23 },
  });
  disclosure.add("headers", token);
  disclosure.addSecrets([token]);
  expect(() => disclosure.verify(["headers"])).toThrow(
    /^Secret disclosure detected$/,
  );
});
