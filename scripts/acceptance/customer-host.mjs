// DEP-001/002: run the actual customer deployment with additive test services.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export async function customerProfiles({
  docker,
  env,
  root,
  output,
  project,
  record,
}) {
  assert.match(project, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  const results = [];
  const previous = { ...env };
  try {
    for (const profile of ["bundled", "external"]) {
      const name = project + "-customer-" + profile;
      const fixture = resolve(root, "tmp", name);
      const evidence = join(output, "customer-" + profile);
      mkdirSync(fixture, { mode: 0o700 });
      mkdirSync(evidence);
      const dbHost = profile === "bundled" ? "database" : "external-database";
      const settings = {
        CUSTOMER_ID: "10000000-0000-4000-8000-000000000002",
        CUSTOMER_NAME: "Controlled customer installation",
        APP_ORIGIN: "https://web:8443",
        PDAA_DB_HOST: dbHost,
        PDAA_DB_PORT: "5432",
        PDAA_DB_NAME: "pdaa",
        PDAA_ADMIN_USER: "postgres",
        PDAA_OPS_TARGET: `${dbHost}:5432/pdaa`,
        PDAA_SECRET_DIR: fixture.replaceAll("\\", "/"),
        PDAA_BACKUP_DIR: join(fixture, "backups").replaceAll("\\", "/"),
        PDAA_HTTPS_BIND: "127.0.0.1",
        PDAA_HTTPS_PORT: "0",
        OIDC_ISSUER: "https://identity-ingress:8443/identity/realms/pdaa",
        OIDC_JWKS_URI:
          "https://identity-ingress:8443/identity/realms/pdaa/protocol/openid-connect/certs",
        OIDC_CLIENT_ID: "pdaa-web",
        OIDC_AUDIENCE: "pdaa-api",
        OIDC_SCOPE: "openid pdaa.read",
        OIDC_GROUP_ROLE_MAP:
          '{"project-managers":["project_manager"],"operators":["system_admin"]}',
      };
      for (const target of ["api", "worker", "web", "operations"])
        settings[`PDAA_${target.toUpperCase()}_IMAGE`] = record.images[target];
      const envFile = join(evidence, "customer.env");
      // Explicit file uses only generated nonsecret settings. Avoid shell interpolation.
      for (const value of Object.values(settings))
        assert(!/[\r\n']/.test(value));
      writeFileSync(
        envFile,
        Object.entries(settings)
          .map(([key, value]) => `${key}='${value}'`)
          .join("\n") + "\n",
      );
      // Compose gives the process environment precedence over the env file.
      // Remove these keys so this test actually exercises the operator's env file.
      for (const key of Object.keys(settings)) delete env[key];
      env.PDAA_CUSTOMER_PROFILE = profile;
      env.PDAA_ARTIFACT_DIR = `/workspace/artifacts/${project}/customer-${profile}`;
      const base = [
        "compose",
        "--env-file",
        envFile,
        "-p",
        name,
        "-f",
        "deploy/customer/compose.yaml",
      ];
      if (profile === "bundled")
        base.push("-f", "deploy/customer/bundled-database.yaml");
      const compose = (...args) => [
        ...base,
        "-f",
        "deploy/acceptance/customer-fixtures.yaml",
        "--profile",
        "test",
        "--profile",
        "operations",
        ...(profile === "external" ? ["--profile", "external"] : []),
        ...args,
      ];
      const run = (args, step, mode = "log") =>
        docker(args, `customer-${profile}-${step}`, mode);
      const service = (serviceName, command = [], patch = {}) =>
        compose(
          "run",
          "--rm",
          "--no-deps",
          ...Object.entries(patch).flatMap(([key, value]) => [
            "-e",
            `${key}=${value}`,
          ]),
          serviceName,
          ...command,
        );
      const check = (phase) => {
        run(
          service("verify", ["node", "scripts/acceptance/customer.mjs", phase]),
          phase,
          "inherit",
        );
        assert.deepEqual(
          JSON.parse(readFileSync(join(evidence, phase + ".json"), "utf8")),
          { runId: project, profile, phase, status: "passed" },
        );
      };
      const container = (serviceName) => {
        const id = run(
          compose("ps", "-a", "-q", serviceName),
          serviceName + "-id",
          "capture",
        );
        assert.match(id, /^[a-f0-9]{64}$/);
        const inspected = JSON.parse(
          run(["inspect", id], serviceName + "-inspect", "capture"),
        )[0];
        assert.equal(
          inspected.Config.Labels["com.docker.compose.project"],
          name,
        );
        assert.equal(
          inspected.Config.Labels["com.docker.compose.service"],
          serviceName,
        );
        return inspected;
      };
      let started = false;
      let failure;
      const productIds = {};
      try {
        console.log(`Testing shipped customer composition: ${profile}`);
        run(
          [
            "run",
            "--rm",
            "--network",
            "none",
            "-e",
            "PDAA_ACCEPTANCE=isolated",
            "--mount",
            `type=bind,src=${fixture},dst=/fixture`,
            record.images.acceptance,
            "node",
            "scripts/acceptance/prepare-customer.mjs",
          ],
          "prepare",
        );
        const shipped = JSON.parse(
          run(
            [...base, "--profile", "operations", "config", "--format", "json"],
            "shipped-config",
            "capture",
          ),
        );
        const resolved = JSON.parse(
          run(
            compose("config", "--format", "json"),
            "fixture-config",
            "capture",
          ),
        );
        for (const [serviceName, definition] of Object.entries(
          shipped.services,
        ))
          assert.deepEqual(
            resolved.services[serviceName],
            definition,
            "Fixtures must not override shipped service " + serviceName,
          );
        assert.equal(Boolean(shipped.services.database), profile === "bundled");
        for (const target of ["api", "worker", "web", "operations"])
          assert.equal(shipped.services[target].image, record.images[target]);
        assert.equal(shipped.services.api.environment.DATA_MODE, "customer");
        assert.equal(shipped.services.worker.environment.SHADOW_MODE, "true");
        assert.equal(
          shipped.services.backup.environment.PDAA_DB_USER,
          "pdaa_backup",
        );
        started = true;
        run(
          compose(
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            dbHost,
            "identity-ingress",
          ),
          "dependencies",
        );
        assert.deepEqual(
          container(dbHost).HostConfig.PortBindings ?? {},
          {},
          "Database must not publish a host port",
        );
        run(service("operations", ["provision"]), "provision");
        run(service("operations", ["provision"]), "provision-repeat");
        run(
          compose(
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "120",
            "api",
            "worker",
            "web",
          ),
          "start",
        );
        for (const target of ["api", "worker", "web"]) {
          const actual = container(target);
          assert.equal(actual.Image, record.images[target]);
          assert.equal(actual.HostConfig.RestartPolicy.Name, "unless-stopped");
          productIds[target] = actual.Id;
        }
        const acceptedDatabase = container(dbHost);
        const databaseId = acceptedDatabase.Id;
        assert.equal(acceptedDatabase.Image, record.databaseImage, "Customer database differs from accepted database image");
        check("installed");
        check("before-upgrade");
        const backupOutput = run(service("backup"), "backup", "capture");
        const backupName = JSON.parse(
          backupOutput
            .split("\n")
            .find((line) => line.startsWith('{"operation"')),
        ).result.file;
        assert.match(backupName, /^backup-[a-zA-Z0-9-]+\.pdaa$/);
        run(compose("stop", "-t", "20", "api", "worker"), "upgrade-stop");
        for (const target of ["api", "worker"])
          assert.equal(container(target).State.Running, false);
        // An operator typo must fail without automatically starting the stopped runtime.
        let denied = false;
        try {
          run(
            service("operations", ["migrate"], {
              PDAA_OPS_TARGET: `${dbHost}:5432/wrong_target`,
            }),
            "upgrade-denied",
          );
        } catch {
          denied = true;
        }
        assert(denied);
        assert(
          readFileSync(
            join(output, `customer-${profile}-upgrade-denied.log`),
            "utf8",
          ).includes('"event":"operations.failed"'),
        );
        for (const target of ["api", "worker"])
          assert.equal(
            container(target).State.Running,
            false,
            "Failed maintenance must leave runtime stopped",
          );
        run(
          service("operations", ["migrate"], {
            PDAA_DB_USER: "pdaa_migrate",
            PDAA_DB_PASSWORD_FILE: "/run/secrets/migration-password",
          }),
          "upgrade-migrate",
        );
        run(
          compose(
            "up",
            "-d",
            "--force-recreate",
            "--wait",
            "--wait-timeout",
            "120",
            "api",
            "worker",
            "web",
          ),
          "upgrade-start",
        );
        assert.equal(container(dbHost).Id, databaseId);
        for (const target of ["api", "worker", "web"]) {
          const actual = container(target);
          assert.notEqual(actual.Id, productIds[target]);
          assert.equal(actual.Image, record.images[target]);
        }
        check("after-upgrade");
        check("restore-target");
        run(
          service("operations", ["restore", backupName], {
            PDAA_DB_NAME: "pdaa_restore",
            PDAA_OPS_TARGET: `${dbHost}:5432/pdaa_restore`,
          }),
          "restore",
        );
        check("restored");
        results.push({
          profile,
          project: name,
          status: "passed",
          databaseImage: acceptedDatabase.Image,
          images: {
            api: record.images.api,
            worker: record.images.worker,
            web: record.images.web,
            operations: record.images.operations,
          },
          checks: [
            "installed",
            "before-upgrade",
            "after-upgrade",
            "restore-target",
            "restored",
          ],
        });
      } catch (error) {
        failure = error;
      } finally {
        if (failure && started) {
          try {
            run(compose("logs", "--no-color"), "diagnostics");
          } catch {
            /* Preserve the failed step. */
          }
        }
        try {
          if (started) {
            assert.equal(name, `${project}-customer-${profile}`);
            run(compose("down", "--remove-orphans", "--volumes"), "stop");
          }
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    }
  } finally {
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previous);
  }
  return results;
}
