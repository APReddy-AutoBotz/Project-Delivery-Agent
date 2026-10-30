// A rejected transaction can leave its server-side outcome uncertain. Retain
// that permit until process restart; successful transaction resolution releases
// it. This intentionally trades availability for a conservative local bound.
export function createAccessOperationAdmission(limit = 4) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("Access operation admission unavailable");
  let used = 0, poisoned = 0;
  return {
    acquire(): null | { complete(): void; poison(): void } {
      if (used >= limit) return null;
      used++;
      let settled = false;
      return {
        complete() { if (settled) throw new Error("Access operation admission unavailable"); settled = true; used--; },
        poison() { if (settled) throw new Error("Access operation admission unavailable"); settled = true; poisoned++; },
      };
    },
    status() { return Object.freeze({ used, poisoned, limit }); },
  };
}
export type AccessOperationAdmission = ReturnType<typeof createAccessOperationAdmission>;
export const sharedAccessOperationAdmission = createAccessOperationAdmission();
