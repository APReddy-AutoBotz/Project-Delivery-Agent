import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { projectUpdateCaptureConfigurationSchema, projectUpdateIssuanceChangeSchema as changeSchema,
  type ProjectUpdateIssuanceChange as UpdateIssuanceChange } from "@pdaa/domain";
import { connect, assertPostgres17, type OperationsConfig } from "./config.js";
import { assertBusinessTableOwner } from "./business-grants.js";
import { assertCustomer } from "./provision.js";
import type { Client } from "pg";

export function readUpdateIssuanceChange(env: NodeJS.ProcessEnv, enable: boolean): UpdateIssuanceChange {
  const value = env.PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION;
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Expected issuance revision required");
  const parsed = changeSchema.safeParse({
    expectedRevision: Number(value), expectedEpoch: env.PDAA_UPDATE_ISSUANCE_EXPECTED_EPOCH, enable,
  });
  if (!parsed.success) throw new Error("Invalid issuance change");
  return parsed.data;
}

function captureFile(path: string | undefined, customerId: string, expectedEpoch: string) {
  try {
    if (!path) throw new Error();
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes.length > 16384 || bytes.includes(0)) throw new Error();
    const configuration = projectUpdateCaptureConfigurationSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (configuration.customerId !== customerId || configuration.issuanceEpoch !== expectedEpoch) throw new Error();
    return configuration;
  } catch { throw new Error("Invalid explicit capture configuration"); }
}

type Gate = { enabled: boolean; epoch: string; revision: number };

// Maintenance only. Runtime credentials cannot modify this gate. This command
// does not promote a restored target or clear database connection quarantine.
export async function updateIssuanceStatus(config: OperationsConfig): Promise<Gate> {
  const client = await connect(config.database);
  try {
    await assertPostgres17(client);
    await assertBusinessTableOwner(client);
    await assertCustomer(client, config);
    const rows = (await client.query(
      'SELECT "issuanceEnabled" AS enabled,"issuanceEpoch" AS epoch,revision FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid',
      [config.customerId],
    )).rows;
    if (rows.length !== 1) throw new Error("Issuance gate unavailable");
    return rows[0] as Gate;
  } finally { await client.end(); }
}

export async function changeUpdateIssuance(
  config: OperationsConfig,
  changeValue: UpdateIssuanceChange,
  capturePath?: string,
): Promise<Gate> {
  const parsed = changeSchema.safeParse(changeValue);
  if (!parsed.success) throw new Error("Invalid issuance change");
  const change = parsed.data;
  if (change.enable) captureFile(capturePath, config.customerId, change.expectedEpoch);
  const client = await connect(config.database);
  try {
    await assertPostgres17(client);
    await assertBusinessTableOwner(client);
    await client.query("BEGIN");
    try {
      // Same maintenance lock as provisioning/release/restore. No implicit
      // application configuration reload can enable restored issuance.
      await client.query("SELECT pg_advisory_xact_lock(72707370)");
      await assertCustomer(client, config);
      const marker = (await client.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )).rows[0]?.marker;
      if (change.enable && marker !== "pdaa.foundation.v1:" + config.customerId)
        throw new Error("Nonquarantined owned customer target required");
      const rows = (await client.query(
        'SELECT "issuanceEnabled" AS enabled,"issuanceEpoch" AS epoch,revision FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid FOR UPDATE',
        [config.customerId],
      )).rows as Gate[];
      const previous = rows[0];
      if (rows.length !== 1 || previous!.revision !== change.expectedRevision ||
          previous!.epoch !== change.expectedEpoch || (change.enable && previous!.enabled))
        throw new Error("Issuance change conflict");
      const epoch = change.enable ? previous!.epoch : randomUUID();
      const auditId = randomUUID();
      await client.query(
        'INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)',
        [auditId, config.customerId, "operator:update-engagement", "project_update.issuance.changed",
          randomUUID(), JSON.stringify({ enabled: change.enable, revision: previous!.revision + 1 })],
      );
      await client.query(
        'UPDATE public."ProjectUpdateIssuanceGate" SET "issuanceEnabled"=$2,"issuanceEpoch"=$3::uuid,revision=revision+1,"changedAt"=date_trunc(\'milliseconds\',clock_timestamp()),"auditEventId"=$4::uuid WHERE "customerId"=$1::uuid AND revision=$5 AND "issuanceEpoch"=$6::uuid',
        [config.customerId, change.enable, epoch, auditId, change.expectedRevision, change.expectedEpoch],
      );
      await client.query("COMMIT");
      return { enabled: change.enable, epoch, revision: previous!.revision + 1 };
    } catch {
      await client.query("ROLLBACK");
      throw new Error("Issuance change failed; state unchanged");
    }
  } finally { await client.end(); }
}

// Called inside the maintenance restore transaction after ownership and current
// customer identity have been checked; saved invitations keep their old epoch.
export async function quarantineUpdateIssuance(client: Pick<Client, "query">, customerId: string) {
  const previous = (await client.query(
    'SELECT "issuanceEpoch" AS epoch,revision FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid FOR UPDATE',
    [customerId],
  )).rows;
  if (previous.length !== 1) throw new Error("Restored issuance gate missing");
  const epoch = randomUUID();
  const auditId = randomUUID();
  await client.query(
    'INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)',
    [auditId, customerId, "restore:quarantine", "project_update.issuance.changed",
      "project-update-restore-quarantine", JSON.stringify({ enabled: false, revision: previous[0].revision + 1 })],
  );
  await client.query(
    'UPDATE public."ProjectUpdateIssuanceGate" SET "issuanceEnabled"=false,"issuanceEpoch"=$2::uuid,revision=revision+1,"changedAt"=date_trunc(\'milliseconds\',clock_timestamp()),"auditEventId"=$3::uuid WHERE "customerId"=$1::uuid',
    [customerId, epoch, auditId],
  );
  const verified = (await client.query(
    'SELECT "issuanceEnabled" AS enabled,"issuanceEpoch" AS epoch FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid',
    [customerId],
  )).rows[0];
  if (!verified || verified.enabled !== false || verified.epoch !== epoch || verified.epoch === previous[0].epoch)
    throw new Error("Restored issuance quarantine not enforced");
  // Bound work; reads also enforce purgeAfter, so even an archive containing
  // more expired bodies cannot disclose them while later batches finish purge.
  await client.query("SELECT public.purge_update_capture_content($1::uuid)", [customerId]);
  return { issuanceDisabled: true, invitationsInvalidated: true };
}
