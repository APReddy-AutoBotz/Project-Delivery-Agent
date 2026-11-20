import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureXlsxPreviewRequest } from "../packages/data/src/ingestion-xlsx-binding.js";
import { mapBoundXlsxPreviewGrid } from "../packages/data/src/ingestion-xlsx-preview.js";
import { readXlsxWorksheet } from "../scripts/acceptance/xlsx-worksheet.mjs";
import {
  book,
  excelTextParts,
  fixtureParts,
  id,
  matrix,
} from "./fixtures/xlsx-test-worksheet.js";

const scope = {
  customerId: id(1),
  sourceId: id(2),
  sheet: "Portfolio",
};
const mapping = {
  configRevision: 9,
  config: {
    ...scope,
    mappingRevision: "7",
    fileName: "synthetic.xlsx",
    identityColumn: "Issue ID",
    projectColumn: "Project",
    projectIds: [id(3), id(6)],
    fields: [
      {
        column: "Forecast",
        factType: "project.forecast",
        type: "date",
        required: true,
      },
    ],
  },
};
const keySha256 = (key: string) =>
  createHash("sha256")
    .update(JSON.stringify(["pdaa.xlsx.row-key.v1", "Portfolio", key]))
    .digest("hex");
const retained = {
  ...scope,
  mappingRevision: "7",
  rows: [
    {
      keyHash: keySha256("001"),
      projectId: id(3),
      fields: [
        {
          factType: "project.forecast",
          value: { type: "date", value: "2027-01-31" },
        },
      ],
    },
    {
      keyHash: keySha256("002"),
      projectId: id(3),
      fields: [
        {
          factType: "project.forecast",
          value: { type: "date", value: "2027-04-15" },
        },
      ],
    },
  ],
};

async function prepare(
  values = matrix,
  profile: "portable" | "excel-text-v1" = "portable",
) {
  const bytes = book(
    profile === "portable" ? fixtureParts(values) : excelTextParts(),
  );
  const captured = captureXlsxPreviewRequest(
    {
      ...scope,
      subject: "synthetic-manager",
      commandKey: "preview-1",
      configRevision: 9,
      mappingRevision: 7,
      parserContract: profile === "portable" ? "portable-v1" : profile,
    },
    bytes,
  );
  bytes.fill(0);
  const grid = await readXlsxWorksheet(
    captured.copyForDecoder(),
    scope.sheet,
    profile,
  );
  return { request: captured.request, grid };
}

describe("FR-CON-006/007 bound XLSX grid comparison", () => {
  it("keeps a new optional-only row with no proposal as a NONE operation", async () => {
    const { request, grid } = await prepare([matrix[0]!, ["001", id(3), ""]]);
    const optional = {
      ...mapping,
      config: {
        ...mapping.config,
        fields: mapping.config.fields.map((field) => ({
          ...field,
          required: false,
        })),
      },
    };
    const preview = mapBoundXlsxPreviewGrid(request, grid, optional, {
      ...retained,
      rows: [],
    });
    expect(preview.rows[0]).toMatchObject({
      status: "VALID",
      operation: "NONE",
      proposals: [],
    });
  });

  it.each(["portable", "excel-text-v1"] as const)(
    "compares a copied %s workbook against retained hashed row identities",
    async (profile) => {
      const { request, grid } = await prepare(matrix, profile);
      const planned = mapBoundXlsxPreviewGrid(request, grid, mapping, retained);
      expect(planned.missingPreviousKeyHashes).toEqual([]);
      expect(
        planned.rows.map(({ rowNumber, keyHash, operation, proposals }) => [
          rowNumber,
          keyHash,
          operation,
          proposals,
        ]),
      ).toEqual([
        [
          2,
          keySha256("001"),
          "UPDATE",
          [
            {
              factType: "project.forecast",
              value: { type: "date", value: "2027-03-02" },
            },
          ],
        ],
        [
          3,
          keySha256("002"),
          "UNCHANGED",
          [
            {
              factType: "project.forecast",
              value: { type: "date", value: "2027-04-15" },
            },
          ],
        ],
      ]);
    },
  );

  it("preserves moved and renamed identity safeguards", async () => {
    const moved = await prepare([
      matrix[0]!,
      ["001", id(6), "2027-03-02"],
      matrix[2]!,
    ]);
    const movedRows = mapBoundXlsxPreviewGrid(
      moved.request,
      moved.grid,
      mapping,
      retained,
    ).rows;
    expect(movedRows[0]).toMatchObject({
      status: "INVALID",
      errors: ["PROJECT_CHANGED"],
      operation: "NONE",
    });
    expect(movedRows[1]?.operation).toBe("UNCHANGED");

    const renamed = await prepare([
      matrix[0]!,
      ["003", id(3), "2027-03-02"],
      matrix[2]!,
    ]);
    const comparison = mapBoundXlsxPreviewGrid(
      renamed.request,
      renamed.grid,
      mapping,
      retained,
    );
    expect(comparison.missingPreviousKeyHashes).toEqual([keySha256("001")]);
    expect(comparison.rows[0]).toMatchObject({
      status: "REVIEW_REQUIRED",
      operation: "NONE",
      errors: ["ROW_IDENTITY_REVIEW"],
    });
  });

  it("denies stale mapping and missing or foreign baseline before marking any CREATE", async () => {
    const { request, grid } = await prepare();
    for (const snapshot of [
      { ...mapping, configRevision: 10 },
      { ...mapping, config: { ...mapping.config, mappingRevision: "8" } },
      { ...mapping, config: { ...mapping.config, sheet: "portfolio" } },
    ])
      expect(() =>
        mapBoundXlsxPreviewGrid(request, grid, snapshot, retained),
      ).toThrow(/STALE_CONFIGURATION/u);
    for (const baseline of [undefined, { ...retained, sourceId: id(8) }]) {
      expect(() =>
        mapBoundXlsxPreviewGrid(request, grid, mapping, baseline),
      ).toThrow(/INVALID_BASELINE/u);
    }
    const initial = mapBoundXlsxPreviewGrid(request, grid, mapping, {
      ...retained,
      rows: [],
    });
    expect(initial.rows.map((row) => row.operation)).toEqual([
      "CREATE",
      "CREATE",
    ]);
  });
});
