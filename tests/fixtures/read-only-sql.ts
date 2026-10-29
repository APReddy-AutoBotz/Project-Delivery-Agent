// Instrumentation aid for the disposable integration test, not a SQL parser.
// SELECT functions, triggers and calls bypassing the proxy remain outside it.
export function possibleMutation(sql: string): boolean {
  const withoutRowLocks = sql.replace(/\bFOR\s+UPDATE\b/gi, "FOR LOCK");
  return /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(withoutRowLocks);
}
export function rawSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join("?");
  if (value && typeof value === "object") {
    const item = value as { sql?: unknown; text?: unknown; strings?: unknown };
    if (typeof item.sql === "string") return item.sql;
    if (typeof item.text === "string") return item.text;
    if (Array.isArray(item.strings) && item.strings.every((entry) => typeof entry === "string")) return item.strings.join("?");
  }
  throw new Error("Unknown raw SQL argument");
}
