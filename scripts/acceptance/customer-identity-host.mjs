// INT-ADM-001: exercise the documented operator env-file/recreate path on the
// unchanged shipped API image. This host never receives an issued bearer token.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  remappingExchange,
  validateRemappingReceipt,
  remappingTimeoutMs,
  remainingRemappingTime,
} from "./remapping-exchange.mjs";
import { rejectLoggedTokens } from "./disclosure.mjs";

export async function checkIdentityConfiguration({
  run,
  compose,
  container,
  settings,
  envFile,
  evidence,
  project,
  name,
  disclosure,
}) {
  assert.equal(name, project + "-customer-bundled");
  const identity = {
    runId: project,
    profile: "bundled",
    session: randomUUID(),
  };
  const exchange = remappingExchange(evidence, identity);
  const deadlineAt = Date.now() + remappingTimeoutMs;
  const originalFile = readFileSync(envFile, "utf8");
  const originalMap = settings.OIDC_GROUP_ROLE_MAP;
  const remainingMappings = JSON.parse(originalMap);
  delete remainingMappings.operators;
  const removedMap = JSON.stringify(remainingMappings);
  const baseline = container("api");
  const dependencies = Object.fromEntries(
    ["worker", "web", "database", "identity", "identity-ingress"].map(
      (service) => [service, container(service).Id],
    ),
  );
  const withoutMap = (inspected) =>
    inspected.Config.Env.filter(
      (value) => !value.startsWith("OIDC_GROUP_ROLE_MAP="),
    ).sort();
  const configuration = (inspected) =>
    inspected.Config.Env.find((value) =>
      value.startsWith("OIDC_GROUP_ROLE_MAP="),
    );
  assert.equal(baseline.Image, settings.PDAA_API_IMAGE);
  assert.equal(configuration(baseline), "OIDC_GROUP_ROLE_MAP=" + originalMap);
  writeFileSync(
    join(evidence, "identity-input.json"),
    JSON.stringify({
      identity,
      deadlineAt,
      metadata: {
        mode: "oidc",
        dataMode: "customer",
        issuer: settings.OIDC_ISSUER,
        clientId: settings.OIDC_CLIENT_ID,
        audience: settings.OIDC_AUDIENCE,
        scope: settings.OIDC_SCOPE,
      },
    }),
  );
  const captureApi = (phase) => {
    const logs = run(
      compose("logs", "--no-color", "api"),
      "identity-api-" + phase,
      "capture-output",
    );
    disclosure.add("service-api", logs);
    rejectLoggedTokens(logs);
  };
  const replace = (mapping, phase) => {
    const lines = originalFile.split("\n");
    assert.equal(
      lines.filter((line) => line.startsWith("OIDC_GROUP_ROLE_MAP=")).length,
      1,
    );
    writeFileSync(
      envFile,
      lines
        .map((line) =>
          line.startsWith("OIDC_GROUP_ROLE_MAP=")
            ? `OIDC_GROUP_ROLE_MAP='${mapping}'`
            : line,
        )
        .join("\n"),
    );
    const resolved = JSON.parse(
      run(
        compose("config", "--format", "json"),
        "identity-config-" + phase,
        "capture",
      ),
    );
    disclosure.add("configuration", readFileSync(envFile, "utf8"));
    disclosure.add("configuration", JSON.stringify(resolved));
    assert.equal(
      resolved.services.api.environment.OIDC_GROUP_ROLE_MAP,
      mapping,
    );
    const previousId = container("api").Id;
    run(
      compose(
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        String(
          Math.max(
            1,
            Math.min(
              120,
              Math.floor(remainingRemappingTime(deadlineAt) / 1000),
            ),
          ),
        ),
        "api",
      ),
      "identity-recreate-" + phase,
    );
    const actual = container("api");
    assert.notEqual(actual.Id, previousId);
    assert.equal(actual.Image, baseline.Image);
    assert.deepEqual(withoutMap(actual), withoutMap(baseline));
    assert.equal(configuration(actual), "OIDC_GROUP_ROLE_MAP=" + mapping);
    for (const [service, id] of Object.entries(dependencies))
      assert.equal(container(service).Id, id);
  };
  let verifier;
  const ownedVerifier = () => {
    assert.match(verifier, /^[a-f0-9]{64}$/);
    const actual = JSON.parse(
      run(["inspect", verifier], "identity-verifier-inspect", "capture"),
    )[0];
    assert.equal(actual.Config.Labels["com.docker.compose.project"], name);
    assert.equal(actual.Config.Labels["com.docker.compose.service"], "verify");
    return actual;
  };
  try {
    verifier = run(
      compose(
        "run",
        "-d",
        "--no-deps",
        "--name",
        name + "-identity-remapping",
        "-e",
        "PDAA_IDENTITY_SESSION=" + identity.session,
        "-e",
        "PDAA_IDENTITY_DEADLINE=" + deadlineAt,
        "verify",
        "node",
        "scripts/acceptance/customer-identity.mjs",
      ),
      "identity-verifier-start",
      "capture",
    );
    ownedVerifier();
    await exchange.wait(
      "receipt",
      "mapped",
      remainingRemappingTime(deadlineAt),
    );
    captureApi("mapped");
    replace(removedMap, "removed");
    exchange.publish("control", "removed");
    await exchange.wait(
      "receipt",
      "removed",
      remainingRemappingTime(deadlineAt),
    );
    captureApi("removed");
    replace(originalMap, "restored");
    exchange.publish("control", "restored");
    await exchange.wait(
      "receipt",
      "restored",
      remainingRemappingTime(deadlineAt),
    );
    assert.equal(
      run(["wait", verifier], "identity-verifier-exit", "capture"),
      "0",
    );
    const finished = ownedVerifier();
    assert.equal(finished.State.Running, false);
    assert.equal(finished.State.ExitCode, 0);
    captureApi("restored");
    const receipt = validateRemappingReceipt(
      JSON.parse(
        readFileSync(join(evidence, "identity-remapping.json"), "utf8"),
      ),
      identity,
    );
    return {
      ...receipt,
      apiImage: baseline.Image,
      apiRecreations: 2,
      dependenciesUnchanged: true,
    };
  } finally {
    writeFileSync(envFile, originalFile);
    if (verifier) {
      ownedVerifier();
      try {
        const logs = run(
          ["logs", verifier],
          "identity-verifier-output",
          "capture-output",
        );
        disclosure.add("execution-logs", logs);
        rejectLoggedTokens(logs);
      } finally {
        run(["rm", "-f", verifier], "identity-verifier-cleanup");
      }
    }
  }
}
