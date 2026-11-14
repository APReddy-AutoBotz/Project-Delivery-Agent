import { expect, it } from "vitest";
import { createRequire } from "node:module";
const { z } = createRequire(new URL("../packages/domain/package.json", import.meta.url))("zod");
import { canonicalProgrammeSchema, canonicalSetupSchema } from "../packages/domain/src/index.js";
import { decodeCreatedProgramme, decodeCreatedProject, decodeProjectList, decodeProjectSetup } from "../apps/web/src/canonical-creation-decoder.js";

const id = "30000000-0000-4000-8000-000000000001", portfolioId = "30000000-0000-4000-8000-000000000050";
const programme = { id, code: "P1", name: "Synthetic programme" };
const setup = { truncated: false, portfolios: [{ id: portfolioId, name: "Synthetic portfolio", programmes: [programme], programmesTruncated: false }] };
const project = { id, portfolioId, code: "S", name: "Synthetic", description: "", reportedStatus: "UNKNOWN" };
const projectSchema = z.strictObject({ id: z.uuid(), portfolioId: z.uuid(), code: z.string(), name: z.string(), description: z.string(), reportedStatus: z.string() });

it("matches representative creation receipt and setup wire cases", () => {
  const programmes: unknown[] = [programme, { ...programme, name: " " }, { ...programme, name: "x".repeat(161) },
    { ...programme, code: "bad code" }, { ...programme, id: "bad" }, { ...programme, extra: true }, null];
  for (const value of programmes) expect(decodeCreatedProgramme(value) !== null).toBe(canonicalProgrammeSchema.safeParse(value).success);
  const setups: unknown[] = [setup, { ...setup, truncated: 1 }, { ...setup, extra: true },
    { ...setup, portfolios: [{ ...setup.portfolios[0], programmes: Array(101).fill(programme) }] },
    { ...setup, portfolios: Array(101).fill(setup.portfolios[0]) }, { ...setup, portfolios: [null] }, null];
  for (const value of setups) expect(decodeProjectSetup(value) !== null).toBe(canonicalSetupSchema.safeParse(value).success);
  expect(decodeCreatedProject({ id })).toEqual({ id });
  expect(decodeCreatedProject({ id, extra: true })).toBeNull();
  expect(decodeCreatedProject({ id: "bad" })).toBeNull();
});

it("validates list entries and exact enumerable keys", () => {
  const values: unknown[] = [[project], [], [null], [{ ...project, portfolioId: "bad" }], [{ ...project, extra: true }], null];
  for (const value of values) expect(decodeProjectList(value) !== null).toBe(z.array(projectSchema).safeParse(value).success);
  const hiddenId = Object.defineProperty({ extra: true }, "id", { value: id, enumerable: false });
  expect(decodeCreatedProject(hiddenId)).toBeNull();
  const inherited = Object.assign(Object.create({ id }), { extra: true });
  expect(decodeCreatedProject(inherited)).toBeNull();
  expect(decodeProjectList(new Array(1))).toBeNull();
});
