const events = new Set([
  "http.request",
  "api.started",
  "api.start_failed",
  "api.fatal",
  "worker.started",
  "worker.pool_error",
  "worker.connection_error",
  "worker.progress_timeout",
  "worker.event",
  "worker.fatal",
  "operations.failed",
  "operations.fatal",
]);
const workerFailure =
  /^worker\.start_failed\.(configuration|startup|running)\.(permission_denied|schema_missing|authentication_failed|connection_refused|certificate_identity|connection_timeout|unknown)$/;
const methods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

// NFR-SEC-005: TypeScript is not a runtime redaction boundary. Serialize only
// known categories and individually validated fields, never arbitrary objects.
export function operationalLog(
  event: string,
  fields: {
    correlationId?: string;
    method?: string;
    status?: number;
    durationMs?: number;
  } = {},
): void {
  const safe: Record<string, string | number> = {
    timestamp: new Date().toISOString(),
    event:
      typeof event === "string" &&
      (events.has(event) || workerFailure.test(event))
        ? event
        : "operational.invalid_event",
  };
  if (fields && typeof fields === "object") {
    // Ignore accessors: validation and serialization must use the same values.
    const value = (key: string) =>
      Object.getOwnPropertyDescriptor(fields, key)?.value;
    const correlationId = value("correlationId");
    const method = value("method");
    const status = value("status");
    const durationMs = value("durationMs");
    if (
      typeof correlationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        correlationId,
      )
    )
      safe.correlationId = correlationId;
    if (typeof method === "string" && methods.has(method)) safe.method = method;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      safe.status = status;
    if (
      typeof durationMs === "number" &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
    )
      safe.durationMs = durationMs;
  }
  console.log(JSON.stringify(safe));
}
