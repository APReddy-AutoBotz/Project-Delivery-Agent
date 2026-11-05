// Reader changes can each advance the access revision. A successful receipt
// proves a newer revision, but the fresh authorized read remains authoritative.
export function confirmsSourceAccess(sourceId: string, expectedRevision: number, result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const saved = result as Record<string, unknown>;
  return Object.keys(saved).sort().join(",") === "revision,sourceId" && typeof saved.sourceId === "string" &&
    saved.sourceId.toLowerCase() === sourceId.toLowerCase() && Number.isSafeInteger(expectedRevision) &&
    Number.isSafeInteger(saved.revision) && (saved.revision as number) > expectedRevision && (saved.revision as number) <= 2147483647;
}
