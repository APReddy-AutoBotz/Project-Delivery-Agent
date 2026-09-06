// Local rehearsals must never inherit driver URL overrides or another service port.
export function assertSyntheticDatabaseUrl(
  value: string,
  expectedDatabase?: string,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid synthetic database target");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.username !== "pdaa" ||
    !url.password ||
    url.search ||
    url.hash ||
    !/^\/(pdaa|pdaa_test(?:_[0-9]+)?|pdaa_restore_[0-9]+)$/.test(
      url.pathname,
    ) ||
    (expectedDatabase && url.pathname !== "/" + expectedDatabase)
  )
    throw new Error(
      "Synthetic database target must be the isolated local PostgreSQL service without URL options",
    );
  return url;
}
