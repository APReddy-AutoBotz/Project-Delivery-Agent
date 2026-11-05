// SEC-AUTH-001: interpret bounded creation receipts without importing the
// server/domain runtime into the browser. The transport enforces byte limits.
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
};

export function decodeCreatedProject(value: unknown): { id: string } | null {
  if (!object(value) || !keys(value, ["id"]) || !uuid(value.id)) return null;
  return { id: value.id };
}

export function decodeCreatedProgramme(value: unknown): { id: string; code: string; name: string } | null {
  if (!object(value) || !keys(value, ["id", "code", "name"]) || !uuid(value.id) || typeof value.code !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(value.code) || typeof value.name !== "string" ||
      value.name.length < 1 || value.name.length > 160 ||
      // eslint-disable-next-line no-control-regex -- Match the canonical wire label contract.
      !/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/.test(value.name) ||
      // eslint-disable-next-line no-control-regex -- Also reject a one-character control label.
      !/^[^\u0000-\u001f\u007f]+$/.test(value.name)) return null;
  return { id: value.id, code: value.code, name: value.name };
}

export function decodeProjectList(value: unknown): Array<{ id: string; portfolioId: string; code: string; name: string; description: string; reportedStatus: string }> | null {
  if (!Array.isArray(value)) return null;
  const projects: Array<{ id: string; portfolioId: string; code: string; name: string; description: string; reportedStatus: string }> = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return null;
    const item: unknown = value[index];
    if (!object(item) || !keys(item, ["id", "portfolioId", "code", "name", "description", "reportedStatus"]) ||
        !uuid(item.id) || !uuid(item.portfolioId) || typeof item.code !== "string" || typeof item.name !== "string" ||
        typeof item.description !== "string" || typeof item.reportedStatus !== "string") return null;
    projects.push({ id: item.id, portfolioId: item.portfolioId, code: item.code, name: item.name,
      description: item.description, reportedStatus: item.reportedStatus });
  }
  return projects;
}

export function decodeProjectSetup(value: unknown): {
  truncated: boolean; portfolios: Array<{ id: string; name: string; programmes: Array<{ id: string; code: string; name: string }>; programmesTruncated: boolean }>;
} | null {
  if (!object(value) || !keys(value, ["truncated", "portfolios"]) || typeof value.truncated !== "boolean" ||
      !Array.isArray(value.portfolios) || value.portfolios.length > 100) return null;
  const portfolios: Array<{ id: string; name: string; programmes: Array<{ id: string; code: string; name: string }>; programmesTruncated: boolean }> = [];
  for (let index = 0; index < value.portfolios.length; index++) {
    if (!Object.hasOwn(value.portfolios, index)) return null;
    const item: unknown = value.portfolios[index];
    if (!object(item) || !keys(item, ["id", "name", "programmes", "programmesTruncated"]) || !uuid(item.id) ||
        typeof item.name !== "string" || typeof item.programmesTruncated !== "boolean" ||
        !Array.isArray(item.programmes) || item.programmes.length > 100) return null;
    const programmes: Array<{ id: string; code: string; name: string }> = [];
    for (let part = 0; part < item.programmes.length; part++) {
      if (!Object.hasOwn(item.programmes, part)) return null;
      const programme = decodeCreatedProgramme(item.programmes[part]);
      if (!programme) return null;
      programmes.push(programme);
    }
    portfolios.push({ id: item.id, name: item.name, programmes, programmesTruncated: item.programmesTruncated });
  }
  return { truncated: value.truncated, portfolios };
}
