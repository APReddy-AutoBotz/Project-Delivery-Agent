import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDisclosureCheck } from "../scripts/acceptance/disclosure.mjs";

it("SEC-SECRET-001: API and worker startup failures emit fixed categories without raw configuration", () => {
  const canary = randomBytes(32).toString("hex");
  for (const service of ["api", "worker"]) {
    const result = spawnSync(
      process.execPath,
      [`apps/${service}/dist/main.js`],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          AUTH_MODE: "development",
          DATA_MODE: "customer",
          ENCRYPTION_KEY: canary,
          PDAA_DATABASE_URL: `postgresql://user:${canary}@invalid.invalid/customer`,
        },
      },
    );
    const disclosure = createDisclosureCheck([canary]);
    disclosure.add("stdout", result.stdout);
    disclosure.add("stderr", result.stderr);
    disclosure.verify(["stdout"]);
    expect(result.status).toBe(1);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe(
      service === "api"
        ? "api.start_failed"
        : "worker.start_failed.configuration.unknown",
    );
    expect(Object.keys(lines[0]).sort()).toEqual(["event", "timestamp"]);
    expect(result.stderr === "").toBe(true);
  }
});
