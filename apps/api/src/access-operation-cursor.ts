import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { accessOperationPositionSchema, accessOperationSearchFiltersSchema,
  type AccessOperationPosition, type AccessOperationSearchFilters } from "./access-operation-search.js";

const maxAgeMs = 15 * 60 * 1000;
const clockSkewMs = 60 * 1000;
const contextSchema = z.strictObject({ customerId: z.uuid(), subject: z.string().min(1).max(2048) })
  .refine(({ subject }) => Buffer.byteLength(subject, "utf8") <= 2048);
const payloadSchema = z.strictObject({
  context: contextSchema,
  filters: accessOperationSearchFiltersSchema,
  position: accessOperationPositionSchema,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
type CursorContext = z.infer<typeof contextSchema>;
type Payload = z.infer<typeof payloadSchema>;
const aad = Buffer.from("pdaa:access-operations:cursor:v2", "utf8");
const messageInfo = Buffer.from("pdaa:access-operations:cursor:message-key:v2", "utf8");
const zeroNonce = Buffer.alloc(12);

function validatePayload(payload: unknown, now: number): Payload {
  const value = payloadSchema.parse(payload);
  if (!Number.isSafeInteger(now) || now < 0 || value.issuedAt > now + clockSkewMs ||
    value.expiresAt !== value.issuedAt + maxAgeMs || value.expiresAt <= now ||
    value.position.occurredAt < value.filters.from || value.position.occurredAt >= value.filters.until)
    throw new Error();
  return value;
}

function canonicalFilters(filters: AccessOperationSearchFilters): string {
  const value = accessOperationSearchFiltersSchema.parse(filters);
  return JSON.stringify([value.actor ?? null, value.action ?? null, value.from, value.until]);
}

// No cursor authorizes access: the caller must authenticate and authorize each
// page. Rotating the root key also affects other encrypted data and requires its
// own reviewed procedure; this codec never rotates keys.
export class AccessOperationCursorCodec {
  private readonly key: Buffer;
  constructor(rootKey: string) {
    const bytes = Buffer.from(rootKey, "base64");
    if (!/^[A-Za-z0-9+/]{43}=$/.test(rootKey) || bytes.length !== 32 || bytes.toString("base64") !== rootKey)
      throw new Error("Access operation cursor unavailable");
    this.key = Buffer.from(hkdfSync("sha256", bytes, Buffer.from("pdaa:cursor:hkdf:v2"), aad, 32));
  }

  // Call before the database read so an otherwise valid page never succeeds
  // only to discover that its next cursor cannot fit the protocol bound.
  assertCanIssue(context: CursorContext, filters: AccessOperationSearchFilters): void {
    try {
      const checkedContext = contextSchema.parse(context), checkedFilters = accessOperationSearchFiltersSchema.parse(filters);
      const worst = { context: checkedContext, filters: checkedFilters,
        position: { occurredAt: checkedFilters.from, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
        issuedAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER };
      const frameLength = 48 + Buffer.byteLength(JSON.stringify(worst), "utf8");
      if (3 + Math.ceil(frameLength * 4 / 3) > 8192) throw new Error();
    } catch { throw new Error("Access operation cursor unavailable"); }
  }

  private seal(payload: Payload, now: number): string {
    const value = validatePayload(payload, now), salt = randomBytes(32);
    const messageKey = Buffer.from(hkdfSync("sha256", this.key, salt, messageInfo, 32));
    const cipher = createCipheriv("aes-256-gcm", messageKey, zeroNonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.concat([aad, salt]));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const token = `v2.${Buffer.concat([salt, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
    if (token.length > 8192) throw new Error();
    return token;
  }

  issue(context: CursorContext, filters: AccessOperationSearchFilters, position: AccessOperationPosition, now = Date.now()): string {
    try { this.assertCanIssue(context, filters); return this.seal({ context, filters, position, issuedAt: now, expiresAt: now + maxAgeMs }, now); }
    catch { throw new Error("Access operation cursor unavailable"); }
  }

  open(token: string, context: CursorContext, filters: AccessOperationSearchFilters, now = Date.now()): Payload {
    try {
      const expectedContext = contextSchema.parse(context), expectedFilters = canonicalFilters(filters);
      if (typeof token !== "string" || token.length > 8192 || !/^v2\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const encoded = token.slice(3), frame = Buffer.from(encoded, "base64url");
      if (frame.length < 49 || frame.toString("base64url") !== encoded) throw new Error();
      const salt = frame.subarray(0, 32);
      const messageKey = Buffer.from(hkdfSync("sha256", this.key, salt, messageInfo, 32));
      const decipher = createDecipheriv("aes-256-gcm", messageKey, zeroNonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.concat([aad, salt])); decipher.setAuthTag(frame.subarray(32, 48));
      const plaintext = Buffer.concat([decipher.update(frame.subarray(48)), decipher.final()]).toString("utf8");
      const value = validatePayload(JSON.parse(plaintext), now);
      if (value.context.customerId !== expectedContext.customerId || value.context.subject !== expectedContext.subject ||
        canonicalFilters(value.filters) !== expectedFilters) throw new Error();
      return value;
    } catch { throw new Error("Invalid access operation cursor"); }
  }

  advance(token: string, context: CursorContext, filters: AccessOperationSearchFilters,
    position: AccessOperationPosition, now = Date.now()): string {
    try {
      const old = this.open(token, context, filters, now), next = accessOperationPositionSchema.parse(position);
      if (next.occurredAt > old.position.occurredAt || (next.occurredAt === old.position.occurredAt &&
        next.id.toLowerCase() >= old.position.id.toLowerCase())) throw new Error();
      this.assertCanIssue(context, filters);
      return this.seal({ ...old, position: next }, now);
    }
    catch { throw new Error("Invalid access operation cursor"); }
  }
}
