import { describe, it, expect } from "vitest";
import {
  canonicalProjectCreateSchema,
  canonicalDateSchema,
  canonicalUrlSchema,
  canonicalActorSchema,
  roles,
} from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
const fixture = () => canonicalFixture("20000000-0000-4000-8000-000000000001");
describe("INT-MOD-001 / FR-MOD-001/002/004/005/007 canonical request invariants", () => {
  it("preserves four date categories, reported health, all responsibility kinds and typed relations", () => {
    const value = fixture();
    expect(canonicalProjectCreateSchema.parse(value)).toEqual(value);
  });
  it.each([
    "2026-02-29",
    "1900-02-29",
    "0000-01-01",
    "2026-04-31",
    "2026-1-01",
    "2026-01-01T00:00:00Z",
    "10000-01-01",
  ])("rejects invalid date-only value %s", (value) =>
    expect(canonicalDateSchema.safeParse(value).success).toBe(false),
  );
  it.each(["0001-01-01", "2000-02-29", "2028-02-29", "9999-12-31"])(
    "retains Gregorian date %s",
    (value) => expect(canonicalDateSchema.parse(value)).toBe(value),
  );
  it("rejects reversed pairs while retaining independent category order and unknown dates", () => {
    const v = fixture();
    v.dates.actualEnd = "2025-12-31";
    expect(canonicalProjectCreateSchema.safeParse(v).success).toBe(false);
    v.dates.actualStart = null;
    expect(canonicalProjectCreateSchema.safeParse(v).success).toBe(true);
  });
  it.each([
    "javascript:alert(1)",
    "http://example.test",
    "https://user:secret@example.test",
    "https://example.test\\@evil.test",
    "https://example.test/\nprivate",
    "https://",
    "https://@example.test/path",
    "https:///example.test/path",
    "https:////example.test/path",
  ])("rejects unsafe source reference %s", (url) =>
    expect(canonicalUrlSchema.safeParse(url).success).toBe(false),
  );
  it("rejects supplied authority, authorship, identity and seals", () => {
    for (const key of [
      "id",
      "createdBy",
      "createdAt",
      "sealed",
      "provenance",
      "approved",
      "customerId",
    ]) {
      expect(
        canonicalProjectCreateSchema.safeParse({
          ...fixture(),
          [key]: "forged",
        }).success,
      ).toBe(false);
    }
  });
  it("rejects PostgreSQL-incompatible NUL in free text while allowing multiline descriptions",()=>{
    for(const field of ["project","raid","revision"]){const value=fixture();if(field==="project")value.description="bad\u0000text";else if(field==="raid")value.raidItems[0].description="bad\u0000text";else value.sourceMappings[0].externalRevision="bad\u0000text";expect(canonicalProjectCreateSchema.safeParse(value).success).toBe(false);}
    const value=fixture();value.description="First line\nSecond line";expect(canonicalProjectCreateSchema.safeParse(value).success).toBe(true);
  });
  it("rejects duplicate keys, missing links, cross-draft references and source target ambiguity", () => {
    const variants = [
      (v: ReturnType<typeof fixture>) => v.sprints.push({ ...v.sprints[0] }),
      (v: ReturnType<typeof fixture>) => (v.workItems[0].sprintKey = "foreign"),
      (v: ReturnType<typeof fixture>) =>
        (v.requiredWorkItems[0].milestoneKey = "foreign"),
      (v: ReturnType<typeof fixture>) =>
        (v.sourceMappings[0].targetKey = "WI-1"),
      (v: ReturnType<typeof fixture>) => (v.sourceMappings[1].targetKey = null),
      (v: ReturnType<typeof fixture>) =>
        v.sourceMappings.push({ ...v.sourceMappings[0] }),
      (v: ReturnType<typeof fixture>) =>
        v.responsibilities.push({ ...v.responsibilities[0] }),
    ];
    for (const change of variants) {
      const v = fixture();
      change(v);
      expect(canonicalProjectCreateSchema.safeParse(v).success).toBe(false);
    }
  });
  it("bounds individual collections and total aggregate size", () => {
    const v = fixture();
    v.sprints = Array.from({ length: 51 }, (_, i) => ({
      ...v.sprints[0],
      key: "S" + i,
    }));
    expect(canonicalProjectCreateSchema.safeParse(v).success).toBe(false);
    const many = fixture();
    for (const key of [
      "sprints",
      "milestones",
      "workItems",
      "raidItems",
    ] as const)
      many[key] = Array.from({ length: 50 }, (_, i) => ({
        ...many[key][0],
        key: "X" + i,
      }));
    expect(canonicalProjectCreateSchema.safeParse(many).success).toBe(false);
  });
  it("recognizes the explicitly configured sixth role, never a responsibility label", () => {
    const actor = {
      subject: "synthetic",
      customerId: "10000000-0000-4000-8000-000000000001",
      roles: [...roles],
    };
    expect(canonicalActorSchema.parse(actor).roles).toHaveLength(6);
    expect(
      canonicalActorSchema.safeParse({ ...actor, roles: ["SPONSOR"] }).success,
    ).toBe(false);
  });
});
