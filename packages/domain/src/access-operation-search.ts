import { z } from "zod";
import type { Actor } from "./actor.js";
import type { AccessOperation } from "./access-operation.js";

// The Z suffix preserves the existing wire convention for recorded database
// wall time; it does not establish the historical writer's time zone.
export const recordedWallTimeSchema = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const time = new Date(value);
    return Number.isFinite(time.getTime()) && time.toISOString() === value;
  });

function isDatabaseText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}

export const accessOperationSearchFiltersSchema = z.strictObject({
  actor: z.string().min(1).max(512).refine(isDatabaseText).optional(),
  action: z.enum(["access.granted", "access.revoked"]).optional(),
  from: recordedWallTimeSchema,
  until: recordedWallTimeSchema,
}).refine(({ from, until }) => {
  const span = Date.parse(until) - Date.parse(from);
  return span > 0 && span <= 31 * 24 * 60 * 60 * 1000;
});

export type AccessOperationSearchFilters = z.infer<typeof accessOperationSearchFiltersSchema>;
export const accessOperationPositionSchema = z.strictObject({
  occurredAt: recordedWallTimeSchema,
  id: z.uuid(),
});
export type AccessOperationPosition = z.infer<typeof accessOperationPositionSchema>;

export interface AccessOperationSearchRepository {
  search(actor: Actor, filters: AccessOperationSearchFilters, after: AccessOperationPosition | null): Promise<AccessOperation[]>;
}
