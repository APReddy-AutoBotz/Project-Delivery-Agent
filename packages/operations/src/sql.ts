// Conservative release lint, not a SQL rewriter. Execute the original file whole.
// Lex in source order: dollar markers inside comments are not function bodies.
export function validateMigrationSql(sql: string) {
  let commands = "";
  for (let i = 0; i < sql.length; ) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end;
      commands += " ";
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unterminated migration comment");
      commands += " ";
      continue;
    }
    const escape =
      /[eE]/.test(sql[i]!) &&
      sql[i + 1] === "'" &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]!));
    if (escape || sql[i] === "'" || sql[i] === '"') {
      if (escape) i++;
      const quote = sql[i++];
      let closed = false;
      while (i < sql.length) {
        if (escape && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated migration literal");
      commands += " literal ";
      continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated migration body");
      i = end + dollar.length;
      commands += " literal ";
      continue;
    }
    commands += sql[i++];
  }
  if (
    /\b(?:CONCURRENTLY|TABLESPACE)\b|(?:^|;)\s*(?:BEGIN|END|COMMIT|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET|RESET|VACUUM|START\s+TRANSACTION|(?:CREATE|DROP|ALTER)\s+DATABASE|\\)/im.test(
      commands,
    )
  )
    throw new Error("Migration needs a separately reviewed execution strategy");
}
