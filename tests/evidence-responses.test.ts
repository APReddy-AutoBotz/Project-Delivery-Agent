import { expect, it } from "vitest";
import {
  factHistoryEntrySchema,
  factHistoryPageSchema,
  assessmentDeliverySchema,
  factCatalogueRequestSchema,
} from "../packages/domain/src/index.js";
import {
  evidenceContractFixture,
  evidenceId,
  factType,
} from "./fixtures/evidence-contract.js";

it("FR-EVD-009: authorized absence and zero access revision are valid without a fabricated fact", () => {
  const empty = {
    factId: null,
    factType,
    throughRevision: 0,
    entries: [],
    next: null,
    historical: true,
  };
  expect(factHistoryPageSchema.parse(empty)).toEqual(empty);
  expect(
    factHistoryPageSchema.safeParse({ ...empty, throughRevision: 1 }).success,
  ).toBe(false);
  const restricted = {
    id: evidenceId,
    sourceId: evidenceId,
    evidenceId,
    revision: 1,
    sourceAccessRevision: 0,
    visibility: "restricted",
    revalidationRequired: true,
  };
  expect(factHistoryEntrySchema.parse(restricted)).toEqual(restricted);
  expect(
    factHistoryEntrySchema.safeParse({
      ...restricted,
      content: { value: "private" },
    }).success,
  ).toBe(false);
});
it("FR-EVD-003/009: saved assessment envelopes reject leaked content, changed clock and current labeling", () => {
  const { delivery } = evidenceContractFixture();
  expect(assessmentDeliverySchema.safeParse(delivery).success).toBe(true);
  for (const patch of [
    { historical: false },
    { asOf: "2026-09-12T00:00:00.000Z" },
    { visibility: "restricted", revalidationRequired: true },
    { result: { ...delivery.result, privateDetail: "hidden" } },
  ])
    expect(
      assessmentDeliverySchema.safeParse({ ...delivery, ...patch }).success,
    ).toBe(false);
  expect(
    assessmentDeliverySchema.safeParse({
      ...delivery,
      visibility: "restricted",
      revalidationRequired: true,
      result: null,
    }).success,
  ).toBe(true);
});
it("FR-EVD-009: catalogue accepts only bounded known cursor fields", () => {
  const request = { projectId: "30000000-0000-4000-8000-000000000001" };
  expect(factCatalogueRequestSchema.parse(request)).toMatchObject({
    afterFactType: null,
    limit: 50,
  });
  for (const patch of [
    { limit: 0 },
    { limit: 101 },
    { afterFactType: "Private Name" },
    { sourceReader: "someone" },
  ])
    expect(
      factCatalogueRequestSchema.safeParse({ ...request, ...patch }).success,
    ).toBe(false);
});
