// SEC-AUTH-001: validate the bounded /me wire representation before it is
// used as an identity. The transport must enforce the encoded-byte limit.
export type WireIdentity = { customerId: string; subject: string; roles: string[] };

const wireUuid = (value: unknown): value is string => typeof value === "string" &&
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);
const wireRoles = new Set(["leadership", "project_manager", "portfolio_manager", "contributor", "pmo_admin", "system_admin"]);
const identityBodyLimit = 65_536;

export function decodeWireIdentity(value: unknown): WireIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["customerId", "subject", "roles"].every((key) => keys.includes(key))) return undefined;
  const candidate = value as { customerId: unknown; subject: unknown; roles: unknown };
  const customerId = candidate.customerId, subject = candidate.subject, inputRoles = candidate.roles;
  if (!wireUuid(customerId) || typeof subject !== "string" || subject.length < 1 || subject.length > identityBodyLimit || !Array.isArray(inputRoles)) return undefined;
  const roleCount = inputRoles.length;
  if (!Number.isSafeInteger(roleCount) || roleCount < 0 || roleCount > identityBodyLimit) return undefined;
  const roles: string[] = [];
  for (let index = 0; index < roleCount; index++) {
    if (!Object.hasOwn(inputRoles, index)) return undefined;
    const role: unknown = inputRoles[index];
    if (typeof role !== "string" || !wireRoles.has(role)) return undefined;
    roles.push(role);
  }
  return { customerId, subject, roles };
}
