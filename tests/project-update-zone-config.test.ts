// FR-ADM-004 / NFR-SEC-001: operator file is tenant-bound and contains no credentials.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/platform/src/config.js";
const directory = mkdtempSync(join(tmpdir(), "pdaa-update-zones-"));
const keys = join(directory, "keys.json"), zones = join(directory, "zones.json");
writeFileSync(keys, JSON.stringify({ currentKeyId: "test", keys: { test: Buffer.alloc(32, 17).toString("base64url") } }));
const env = {
  NODE_ENV: "test", AUTH_MODE: "development", DEPLOYMENT_MODE: "local", DATA_MODE: "synthetic",
  CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
  ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"), SESSION_SECRET: "s".repeat(64),
  PDAA_DATABASE_URL: "postgresql://pdaa:fixture@127.0.0.1:55432/pdaa",
  CONNECTOR_TASK_KEYS_FILE: keys, PROJECT_UPDATE_TASK_KEYS_FILE: keys,
  PROJECT_UPDATE_SERVICE_SUBJECT: "update-service", INTERNAL_API_URL: "http://127.0.0.1:3001",
  PROJECT_UPDATE_ZONES_FILE: zones,
};
afterAll(() => { unlinkSync(keys); unlinkSync(zones); rmdirSync(directory); });
it("loads canonical customer and subject preferences from a strictly scoped file", () => {
  writeFileSync(zones, JSON.stringify({ customerId: env.CUSTOMER_ID, customerTimeZone: "utc",
    recipientTimeZones: [{ subject: "owner", timeZone: "america/new_york" }] }));
  expect(loadConfig(env).projectUpdateZones).toMatchObject({ customerId: env.CUSTOMER_ID,
    customerTimeZone: "UTC", recipientTimeZones: [{ subject: "owner", timeZone: "America/New_York" }] });
});
it.each([
  { customerId: "20000000-0000-4000-8000-000000000001", customerTimeZone: "UTC", recipientTimeZones: [] },
  { customerTimeZone: "UTC", recipientTimeZones: [] },
  { customerId: env.CUSTOMER_ID, customerTimeZone: "+05:30", recipientTimeZones: [] },
  { customerId: env.CUSTOMER_ID, customerTimeZone: "UTC", recipientTimeZones: [], secret: "private" },
  { customerId: env.CUSTOMER_ID, customerTimeZone: "UTC", recipientTimeZones: [{ subject: "owner", timeZone: "UTC" }, { subject: "owner", timeZone: "UTC" }] },
])("rejects invalid or cross-tenant operator configuration without echoing content", (value) => {
  writeFileSync(zones, JSON.stringify(value));
  expect(() => loadConfig(env)).toThrow(/^Invalid project update zone configuration$/);
});
it("requires the existing signed service configuration", () => {
  writeFileSync(zones, JSON.stringify({ customerId: env.CUSTOMER_ID, customerTimeZone: "UTC", recipientTimeZones: [] }));
  expect(() => loadConfig({ ...env, PROJECT_UPDATE_TASK_KEYS_FILE: undefined, PROJECT_UPDATE_SERVICE_SUBJECT: undefined }))
    .toThrow(/^Engagement processing requires project update task authentication$/);
});
