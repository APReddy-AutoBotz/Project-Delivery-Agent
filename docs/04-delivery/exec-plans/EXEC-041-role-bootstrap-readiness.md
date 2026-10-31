# EXEC-041: Wait for the isolated role-bootstrap TCP endpoint

Status: implementation in progress; no acceptance increment. PR #136 candidate
checks passed, but post-merge Foundation 41192305015 verify failed at the first
database-list query in the fresh disposable role-bootstrap cluster with a
connection termination. The hosted log has no server-side lifecycle evidence,
so the root cause is unknown. Its separate production-boundary job passed.
Preserve the failure and its distinct checkpoint.

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

The corrected candidate's Foundation run 41193544320 passed the fresh
role-bootstrap check, then its separate production-boundary job failed in the
`loaded-details-disclosure` capture. The bounded diagnostic recorded a response
continuation failure; `tokenSeen` meant that the expected token endpoint
response had been observed, not that a token leak was detected. Capture stopped
before the final disclosure and expiry assertions. The affected request and
underlying CDP error were not identified; this is an incomplete security check,
not evidence of a clean result or a proven disclosure.

Before opening the project card, the verifier now settles and drains the
current view's observed in-flight requests and recorded responses. This reduces a possible cancellation race
with the list's abortable PM queue; it does not prove that race caused the
previous failure or preclude later requests. Continuation failures remain fatal.
Additional continuation diagnostics use fixed categories only and never emit
raw URLs, request IDs, headers, bodies, credentials or error messages. A
synthetic Chromium fixture tests response/continuation ordering, canary
detection and forced-continuation failure without claiming the packaged
OIDC flow. Complete hosted checks remain required.

An initial Chromium regression exposed that a previously fired `networkidle`
event did not wait for a later request. Request lifecycle tracking and a bounded
drain now cover observed work before interaction, after DOM capture and before
intentional close; work that starts after a completed barrier is not ruled out.
Chromium also reported an already received synthetic POST 204 as aborted by an
immediate navigation. The verifier accepts only that exact same-request,
same-origin POST 204 with Chromium's `net::ERR_ABORTED` and no service-worker
response, after independently capturing its original response headers for
secret scanning. This independent header path does not prove CDP captured that
particular response; every observed CDP capture failure remains fatal, as do
all other failed requests. This synthetic observation does not explain the
hosted failure.

The next candidate's Foundation run 41195299060 failed its production job
after the intentionally rejected wrong-hostname TLS page was opened and closed
inside the disclosure context. The stricter tracker recorded a failed request
and an unexpected page close. This is distinct from the earlier continuation
failure; neither run established a secret leak or completed the full packaged
check. Keep the hostname rejection assertion and the disclosure tracker strict.
The negative hostname probe now uses a fresh anonymous context in the same
browser, with certificate validation enabled, no pre-existing cookies and no
delivered response; the same exact hostname-error assertion remains. This
does not prove the earlier continuation failure's cause. A separate synthetic
Chromium test uses an untrusted local certificate to exercise context isolation
and confirms an unexpected close in the recorded context remains fatal; the
packaged hostname-specific check must still run.

Unit tests cover delayed readiness, expiry, mismatch, error classes, an emitted
client error, forced socket destruction and no retries of acceptance. These do
not replace the required real isolated PostgreSQL and hosted role-bootstrap
checks. A local unresponsive TCP fixture can check the actual PostgreSQL client
socket's closure without claiming a successful database or migration. Do not
claim the hosted failure's cause or credit any story or release hold from this
infrastructure hardening. Original19/20 capture remains stopped.
