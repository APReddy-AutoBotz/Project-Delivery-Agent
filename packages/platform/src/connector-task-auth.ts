import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type ConnectorTaskKeyRing = {
  currentKeyId: string;
  keys: Record<string, string>;
};
export type ConnectorTaskHeaders = {
  "x-pdaa-task-key": string;
  "x-pdaa-task-time": string;
  "x-pdaa-task-nonce": string;
  "x-pdaa-task-signature": string;
};

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function message(method: string, path: string, timestamp: string, nonce: string, body: Uint8Array) {
  return [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
}

export function signConnectorTaskRequest(input: {
  method: string;
  path: string;
  body: Uint8Array;
  keyRing: ConnectorTaskKeyRing;
  now?: number;
  nonce?: string;
}): ConnectorTaskHeaders {
  const keyId = input.keyRing.currentKeyId;
  const encodedKey = input.keyRing.keys[keyId];
  if (!encodedKey) throw new Error("Connector task signing key unavailable");
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
  const nonce = input.nonce ?? randomUUID();
  if (!uuidPattern.test(nonce)) throw new Error("Invalid connector task nonce");
  const signature = createHmac("sha256", Buffer.from(encodedKey, "base64url"))
    .update(message(input.method, input.path, timestamp, nonce, input.body))
    .digest("base64url");
  return {
    "x-pdaa-task-key": keyId,
    "x-pdaa-task-time": timestamp,
    "x-pdaa-task-nonce": nonce,
    "x-pdaa-task-signature": signature,
  };
}

export function verifyConnectorTaskRequest(input: {
  method: string;
  path: string;
  body: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  keyRing: ConnectorTaskKeyRing | null;
  now?: number;
  maxClockSkewSeconds?: number;
}): boolean {
  if (!input.keyRing) return false;
  const get = (name: string) => {
    const value = input.headers[name];
    return typeof value === "string" && value.length <= 256 ? value : "";
  };
  const keyId = get("x-pdaa-task-key");
  const timestamp = get("x-pdaa-task-time");
  const nonce = get("x-pdaa-task-nonce");
  const supplied = get("x-pdaa-task-signature");
  const key = input.keyRing.keys[keyId];
  if (
    !key ||
    !/^[0-9]{10}$/.test(timestamp) ||
    !uuidPattern.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(supplied)
  ) return false;
  const seconds = Number(timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const skew = input.maxClockSkewSeconds ?? 60;
  if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) > skew) return false;
  const expected = createHmac("sha256", Buffer.from(key, "base64url"))
    .update(message(input.method, input.path, timestamp, nonce, input.body))
    .digest();
  const decoded = Buffer.from(supplied, "base64url");
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}
