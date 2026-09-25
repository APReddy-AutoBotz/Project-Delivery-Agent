export const ingestionPersistenceErrorCodes = [
  "DENIED",
  "INVALID_REQUEST",
  "CONFLICT",
  "STALE_CONFIGURATION",
  "CURSOR_CONFLICT",
  "RETENTION_REQUIRED",
  "NOT_FOUND",
  "INVALID_PREVIEW",
  "INTEGRITY_CONFLICT",
  "PERSISTENCE_FAILED",
] as const;

export type IngestionPersistenceErrorCode =
  (typeof ingestionPersistenceErrorCodes)[number];

export class IngestionPersistenceError extends Error {
  constructor(readonly code: IngestionPersistenceErrorCode) {
    super(code);
    this.name = "IngestionPersistenceError";
  }
}
