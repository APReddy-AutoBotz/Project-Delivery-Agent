// FR-MOD-001/002/003/004/005/006/007: explicit human configuration, never evidence.
import { z } from "zod";
import { roles, roleSchema, type Actor } from "./actor.js";
// eslint-disable-next-line no-control-regex -- PostgreSQL text rejects NUL; preserve ordinary multiline text.
const nulFreeText = /^[^\u0000]*$/;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- Wire labels must exclude control bytes.
    .regex(/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/)
    // eslint-disable-next-line no-control-regex -- Also rejects a one-character control label.
    .regex(/^[^\u0000-\u001f\u007f]+$/);
export const canonicalKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const canonicalSubjectSchema = text(200);
export const canonicalActorSchema = z.strictObject({
  subject: canonicalSubjectSchema,
  customerId: z.uuid(),
  roles: z
    .array(roleSchema)
    .max(roles.length)
    .refine((v) => new Set(v).size === v.length),
});
export const canonicalDateFields = [
  "baselineStart",
  "baselineEnd",
  "plannedStart",
  "plannedEnd",
  "forecastStart",
  "forecastEnd",
  "actualStart",
  "actualEnd",
] as const;
export const canonicalDateSchema = z
  .string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
    return (
      month! >= 1 &&
      month! <= 12 &&
      day! >= 1 &&
      day! <=
        [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
          month! - 1
        ]!
    );
  }, "Use a valid calendar date");
const date = canonicalDateSchema.nullable();
export const canonicalDatesSchema = z
  .strictObject({
    baselineStart: date,
    baselineEnd: date,
    plannedStart: date,
    plannedEnd: date,
    forecastStart: date,
    forecastEnd: date,
    actualStart: date,
    actualEnd: date,
  })
  .refine(
    (value) =>
      (["baseline", "planned", "forecast", "actual"] as const).every(
        (key) =>
          !value[`${key}Start`] ||
          !value[`${key}End`] ||
          value[`${key}Start`]! <= value[`${key}End`]!,
      ),
    "End dates must follow their corresponding start dates",
  );
export const emptyCanonicalDates = (): z.infer<
  typeof canonicalDatesSchema
> => ({
  baselineStart: null,
  baselineEnd: null,
  plannedStart: null,
  plannedEnd: null,
  forecastStart: null,
  forecastEnd: null,
  actualStart: null,
  actualEnd: null,
});
const key = canonicalKeySchema;
const state = z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]);
const responsibility = z.strictObject({
  role: z.enum([
    "SPONSOR",
    "PROJECT_MANAGER",
    "SCRUM_MASTER",
    "TEAM_LEAD",
    "RESPONSIBLE_OWNER",
  ]),
  subject: canonicalSubjectSchema,
  displayName: text(160),
});
const sprint = z.strictObject({
  key,
  name: text(160),
  dates: canonicalDatesSchema,
});
const milestone = sprint.extend({ state });
const workItem = z.strictObject({
  key,
  title: text(160),
  state,
  sprintKey: key.nullable(),
  dates: canonicalDatesSchema,
});
const requiredWorkItem = z.strictObject({
  milestoneKey: key,
  workItemKey: key,
});
const raidItem = z.strictObject({
  key,
  kind: z.enum([
    "RISK",
    "ASSUMPTION",
    "ISSUE",
    "DEPENDENCY",
    "DECISION",
    "ACTION",
  ]),
  title: text(160),
  description: z.string().max(4096).regex(nulFreeText),
  state,
  ownerSubject: canonicalSubjectSchema.nullable(),
});
export const canonicalUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^/?#@\\\s]+(?:[/?#][^\s\\]*)?$/)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        // eslint-disable-next-line no-control-regex -- WHATWG parsing must not normalize forbidden control bytes.
        !/[\u0000-\u001f\u007f]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use a credential-free HTTPS URL");
const sourceMapping = z.strictObject({
  sourceSystem: text(64),
  instanceKey: key,
  externalType: text(64),
  externalId: text(200),
  externalRevision: z.string().max(128).regex(nulFreeText).nullable(),
  url: canonicalUrlSchema.nullable(),
  targetType: z.enum([
    "PROJECT",
    "SPRINT",
    "MILESTONE",
    "WORK_ITEM",
    "RAID_ITEM",
  ]),
  targetKey: key.nullable(),
});
export const canonicalCollectionsSchema = z.strictObject({
  responsibilities: z.array(responsibility).max(50),
  sprints: z.array(sprint).max(50),
  milestones: z.array(milestone).max(50),
  workItems: z.array(workItem).max(50),
  requiredWorkItems: z.array(requiredWorkItem).max(50),
  raidItems: z.array(raidItem).max(50),
  sourceMappings: z.array(sourceMapping).max(50),
});
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const canonicalProgrammeCreateSchema = z.strictObject({
  code: key,
  name: text(160),
  idempotencyKey,
});
export const canonicalProjectCreateSchema = z
  .strictObject({
    portfolioId: z.uuid(),
    programmeId: z.uuid().nullable(),
    code: key,
    name: text(160),
    description: z.string().max(4096).regex(nulFreeText),
    reportedStatus: z.enum(["GREEN", "AMBER", "RED", "UNKNOWN"]),
    dates: canonicalDatesSchema,
    ...canonicalCollectionsSchema.shape,
    idempotencyKey,
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      Object.keys(canonicalCollectionsSchema.shape).reduce(
        (sum, k) =>
          sum +
          value[k as keyof typeof canonicalCollectionsSchema.shape].length,
        0,
      ) > 200
    )
      fail("At most 200 child records are allowed");
    for (const name of [
      "sprints",
      "milestones",
      "workItems",
      "raidItems",
    ] as const)
      if (
        new Set(value[name].map((row) => row.key)).size !== value[name].length
      )
        fail("Record keys must be unique within each collection");
    if (
      new Set(
        value.responsibilities.map((row) =>
          JSON.stringify([row.role, row.subject]),
        ),
      ).size !== value.responsibilities.length
    )
      fail("Responsibility assignments must be unique");
    if (
      new Set(
        value.requiredWorkItems.map((row) =>
          JSON.stringify([row.milestoneKey, row.workItemKey]),
        ),
      ).size !== value.requiredWorkItems.length
    )
      fail("Required work links must be unique");
    if (
      new Set(
        value.sourceMappings.map((row) =>
          JSON.stringify([
            row.sourceSystem,
            row.instanceKey,
            row.externalType,
            row.externalId,
          ]),
        ),
      ).size !== value.sourceMappings.length
    )
      fail("External source identities must be unique");
    const has = (
      name: "sprints" | "milestones" | "workItems" | "raidItems",
      id: string,
    ) => value[name].some((row) => row.key === id);
    for (const row of value.workItems)
      if (row.sprintKey && !has("sprints", row.sprintKey))
        fail("A sprint reference must belong to this project draft");
    for (const row of value.requiredWorkItems)
      if (
        !has("milestones", row.milestoneKey) ||
        !has("workItems", row.workItemKey)
      )
        fail("Required work links must belong to this project draft");
    for (const row of value.sourceMappings) {
      const collection = {
        SPRINT: "sprints",
        MILESTONE: "milestones",
        WORK_ITEM: "workItems",
        RAID_ITEM: "raidItems",
      } as const;
      if (
        row.targetType === "PROJECT"
          ? row.targetKey !== null
          : !row.targetKey || !has(collection[row.targetType], row.targetKey)
      )
        fail("A source mapping target must belong to this project draft");
    }
  });
export const canonicalProgrammeSchema = z.strictObject({
  id: z.uuid(),
  code: key,
  name: text(160),
});
export const canonicalSetupSchema = z.strictObject({
  truncated: z.boolean(),
  portfolios: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        programmes: z.array(canonicalProgrammeSchema).max(100),
        programmesTruncated: z.boolean(),
      }),
    )
    .max(100),
});
const id = { id: z.uuid() };
export const canonicalProjectDetailSchema = z.strictObject({
  ...id,
  portfolio: z.strictObject({ ...id, name: z.string() }),
  programme: canonicalProgrammeSchema.nullable(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  reportedStatus: z.string(),
  configured: z.boolean(),
  creation: z
    .strictObject({
      by: canonicalSubjectSchema,
      at: z.iso.datetime(),
      revision: z.literal(1),
    })
    .nullable(),
  dates: canonicalDatesSchema,
  responsibilities: z.array(responsibility.extend(id)).max(50),
  sprints: z.array(sprint.extend(id)).max(50),
  milestones: z.array(milestone.extend(id)).max(50),
  workItems: z.array(workItem.extend(id)).max(50),
  requiredWorkItems: z.array(requiredWorkItem).max(50),
  raidItems: z.array(raidItem.extend(id)).max(50),
  sourceMappings: z.array(sourceMapping.extend(id)).max(50),
  sourceMappingsWithheld: z.boolean(),
});
export type CanonicalProjectCreate = z.infer<
  typeof canonicalProjectCreateSchema
>;
export type CanonicalProgrammeCreate = z.infer<
  typeof canonicalProgrammeCreateSchema
>;
export type CanonicalProjectDetail = z.infer<
  typeof canonicalProjectDetailSchema
>;
export type CanonicalSetup = z.infer<typeof canonicalSetupSchema>;
export type CanonicalDates = z.infer<typeof canonicalDatesSchema>;
export class CanonicalProjectError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "DENIED" | "CONFLICT" | "UNAVAILABLE",
  ) {
    super(code);
    this.name = "CanonicalProjectError";
  }
}
export interface CanonicalProjectRepository {
  setup(actor: Actor): Promise<CanonicalSetup>;
  createProgramme(
    actor: Actor,
    portfolioId: string,
    input: CanonicalProgrammeCreate,
    correlationId: string,
  ): Promise<z.infer<typeof canonicalProgrammeSchema>>;
  createProject(
    actor: Actor,
    input: CanonicalProjectCreate,
    correlationId: string,
  ): Promise<{ id: string }>;
  detail(actor: Actor, id: string): Promise<CanonicalProjectDetail>;
}
