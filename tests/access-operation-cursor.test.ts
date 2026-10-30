import { expect, it } from "vitest";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { AccessOperationCursorCodec } from "../apps/api/src/access-operation-cursor.js";
import { accessOperationSearchFiltersSchema } from "../apps/api/src/access-operation-search.js";

const key = Buffer.alloc(32, 7).toString("base64");
const context = { customerId: "10000000-0000-4000-8000-000000000001", subject: "sensitive-operator" };
const filters = { actor: "sensitive-actor", action: "access.granted" as const,
  from: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" };
const position = { occurredAt: "2026-10-15T00:00:00.123Z", id: "20000000-0000-4000-8000-000000000002" };
const now = 1792000000000;

it("seals fresh opaque cursors and binds context and every filter", () => {
  const codec = new AccessOperationCursorCodec(key), a = codec.issue(context, filters, position, now), b = codec.issue(context, filters, position, now);
  expect(a).not.toBe(b); expect(a).not.toContain(context.subject); expect(a).not.toContain(filters.actor);
  expect(codec.open(a, context, filters, now).position).toEqual(position);
  const frame = Buffer.from(a.slice(3), "base64url"), otherFrame = Buffer.from(b.slice(3), "base64url");
  expect(frame.subarray(0, 32).equals(otherFrame.subarray(0, 32))).toBe(false);
  const aad = Buffer.from("pdaa:access-operations:cursor:v2"), salt = frame.subarray(0, 32);
  const root = hkdfSync("sha256", Buffer.from(key, "base64"), Buffer.from("pdaa:cursor:hkdf:v2"), aad, 32);
  const messageKey = hkdfSync("sha256", root, salt, Buffer.from("pdaa:access-operations:cursor:message-key:v2"), 32);
  const decipher = createDecipheriv("aes-256-gcm", messageKey, Buffer.alloc(12));
  decipher.setAAD(Buffer.concat([aad, salt])); decipher.setAuthTag(frame.subarray(32, 48));
  expect(JSON.parse(Buffer.concat([decipher.update(frame.subarray(48)), decipher.final()]).toString()).position).toEqual(position);
  expect(() => codec.open(a, { ...context, subject: "another" }, filters, now)).toThrow("Invalid access operation cursor");
  expect(() => codec.open(a, { ...context, customerId: "10000000-0000-4000-8000-000000000002" }, filters, now)).toThrow();
  for (const changed of [{ ...filters, actor: "another" }, { ...filters, action: "access.revoked" as const },
    { ...filters, from: "2026-10-02T00:00:00.000Z" }, { ...filters, until: "2026-10-31T00:00:00.000Z" }])
    expect(() => codec.open(a, context, changed, now)).toThrow("Invalid access operation cursor");
});
it("rejects tampering, noncanonical framing, wrong key and oversized input", () => {
  const codec = new AccessOperationCursorCodec(key), token = codec.issue(context, filters, position, now);
  const bytes = Buffer.from(token.slice(3), "base64url");
  for (const index of [0, 31, 32, 47, 48, bytes.length - 1]) {
    const altered = Buffer.from(bytes); altered[index] ^= 1;
    expect(() => codec.open(`v2.${altered.toString("base64url")}`, context, filters, now)).toThrow("Invalid access operation cursor");
  }
  for (const invalid of ["v1." + token.slice(3), token + "=", "v2.a", "v2." + "a".repeat(8192), "v2."])
    expect(() => codec.open(invalid, context, filters, now)).toThrow("Invalid access operation cursor");
  expect(() => new AccessOperationCursorCodec(Buffer.alloc(32, 8).toString("base64")).open(token, context, filters, now)).toThrow();
  expect(() => new AccessOperationCursorCodec("not-a-key")).toThrow("Access operation cursor unavailable");
});
it("keeps the original expiry across pages and enforces clock and range bounds", () => {
  const codec = new AccessOperationCursorCodec(key), token = codec.issue(context, filters, position, now);
  const nextPosition = { ...position, id: "20000000-0000-4000-8000-000000000001" };
  const next = codec.advance(token, context, filters, nextPosition, now + 800000);
  expect(Buffer.from(next.slice(3), "base64url").subarray(0, 32).equals(Buffer.from(token.slice(3), "base64url").subarray(0, 32))).toBe(false);
  const value = codec.open(next, context, filters, now + 899999);
  expect(value.issuedAt).toBe(now); expect(value.expiresAt).toBe(now + 900000); expect(value.position).toEqual(nextPosition);
  expect(() => codec.open(next, context, filters, now + 900000)).toThrow();
  expect(() => codec.open(token, context, filters, now - 60001)).toThrow();
  expect(codec.open(token, context, filters, now - 60000).position).toEqual(position);
  expect(() => codec.advance(token, context, filters, { ...position, occurredAt: filters.until }, now)).toThrow();
  expect(() => codec.advance(token, context, filters, position, now)).toThrow();
  expect(() => codec.advance(token, context, filters, { ...position, id: "20000000-0000-4000-8000-000000000003" }, now)).toThrow();
  expect(() => codec.issue({ ...context, subject: "😀".repeat(600) }, filters, position, now)).toThrow("Access operation cursor unavailable");
  expect(() => codec.assertCanIssue({ ...context, subject: "\u0001".repeat(2048) }, filters)).toThrow("Access operation cursor unavailable");
  expect(() => codec.assertCanIssue({ ...context, subject: "😀".repeat(512) }, filters)).not.toThrow();
});
it("validates finite recorded-wall-time intervals without normalizing actor identity", () => {
  expect(accessOperationSearchFiltersSchema.parse(filters).actor).toBe(filters.actor);
  for (const input of [{ ...filters, from: filters.until }, { ...filters, until: "2026-11-02T00:00:00.000Z" },
    { ...filters, from: "2026-02-30T00:00:00.000Z" }, { ...filters, from: "2026-10-01T00:00:00Z" },
    { ...filters, projectId: "not-supported" }, { ...filters, actor: "" },
    { ...filters, actor: "\u0000" }, { ...filters, actor: "\ud800" }, { ...filters, actor: "\udc00" }])
    expect(accessOperationSearchFiltersSchema.safeParse(input).success).toBe(false);
  for (const actor of [" ", "\ufffd", "😀", "x".repeat(512)])
    expect(accessOperationSearchFiltersSchema.parse({ ...filters, actor }).actor).toBe(actor);
});
