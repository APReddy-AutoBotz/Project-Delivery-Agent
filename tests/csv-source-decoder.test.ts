import { describe, expect, it } from "vitest";
import { ingestionSourceSummarySchema } from "../packages/domain/src/ingestion-persistence.js";
import { decodeSources } from "../apps/web/src/csv-ingestion.js";

const customerId = "10000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
const fixture = () => ({ sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 2, mappingRevision: 1,
  healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
  configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
    projects: [{ projectId: "30000000-0000-4000-8000-000000000001", readers: ["actor-a"] }],
    mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID",
      fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } });

describe("CSV source read admission", () => {
  it("accepts a representative strict domain source", () => {
    const value = fixture(); expect(ingestionSourceSummarySchema.safeParse(value).success).toBe(true);
    expect(decodeSources([value], customerId)).toEqual([value]);
  });
  it("rejects malformed field and source shapes rejected by the domain contract", () => {
    const badFact = fixture(); badFact.configuration.mapping.fields[0]!.factType = "Invalid Fact";
    const duplicate = fixture(); duplicate.configuration.mapping.fields.push({ ...duplicate.configuration.mapping.fields[0]! });
    const tooMany = fixture(); tooMany.configuration.projects[0]!.readers = Array.from({ length: 101 }, (_, index) => `reader-${index}`);
    const enumArray = { ...fixture(), healthState: ["UNKNOWN"] };
    const codeArray = { ...fixture(), healthCode: ["NONE"] };
    const fieldArray = fixture(); const field = fieldArray.configuration.mapping.fields[0]!;
    const badType = { ...fieldArray, configuration: { ...fieldArray.configuration, mapping: { ...fieldArray.configuration.mapping, fields: [{ ...field, type: ["date"] }] } } };
    for (const value of [badFact, duplicate, tooMany, { ...fixture(), surprise: true }, enumArray, codeArray, badType]) {
      expect(ingestionSourceSummarySchema.safeParse(value).success).toBe(false);
      expect(() => decodeSources([value], customerId)).toThrow();
    }
  });
  it("also requires source binding consistency and unique source identities", () => {
    const otherCustomer = fixture(); otherCustomer.configuration.binding.customerId = "10000000-0000-4000-8000-000000000002";
    const differentOrigin = fixture(); differentOrigin.configuration.binding.origin = "https://other.invalid";
    for (const value of [otherCustomer, differentOrigin]) expect(() => decodeSources([value], customerId)).toThrow();
    expect(() => decodeSources([fixture(), fixture()], customerId)).toThrow();
  });
});
