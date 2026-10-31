# EXEC-041: Wait for the isolated role-bootstrap TCP endpoint

Status: implementation in progress; no acceptance increment. PR #136 candidate
checks passed, but post-merge Foundation 41192305015 verify failed at the first
database-list query in the fresh disposable role-bootstrap cluster with a
connection termination. The hosted log has no server-side lifecycle evidence,
so the root cause is unknown. The production-boundary job was still running at
the time of this record. Preserve the failure and its distinct checkpoint.

The existing startup loop probes the container's Unix socket with `pg_isready`,
while acceptance connects through the loopback-mapped TCP endpoint. A temporary
initialization server can make the socket ready before the final TCP listener;
this is a plausible race, not a finding that it caused the observed failure.
Wait instead for a fresh authenticated client to query the actual mapped TCP
endpoint and confirm its database/user before executing any acceptance work.
Limit readiness attempts and each owned client, reject mismatched identity and
nontransient errors without exposing credentials, and never retry acceptance,
migration or security assertions. Keep existing container identity and cleanup
checks; if cleanup also fails, preserve and report the original failure.

PR #137's first candidate Foundation run 41193148089 failed its verify job at
lint before running the bootstrap checks. It identified an unnecessary initial
assignment and a throw from a `finally` block in the readiness helper. The
corrected candidate must pass lint and the full hosted gates; the initial
failure is not erased by a later result.

Unit tests cover delayed readiness, expiry, mismatch, error classes, an emitted
client error, forced socket destruction and no retries of acceptance. These do
not replace the required real isolated PostgreSQL and hosted role-bootstrap
checks. A local unresponsive TCP fixture can check the actual PostgreSQL client
socket's closure without claiming a successful database or migration. Do not
claim the hosted failure's cause or credit any story or release hold from this
infrastructure hardening. Original19/20 capture remains stopped.
