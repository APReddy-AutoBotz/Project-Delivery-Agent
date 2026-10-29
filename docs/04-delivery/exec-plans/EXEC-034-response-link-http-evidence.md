# EXEC-034: Real response-link denial evidence

Status: Local work in progress; no acceptance or publication is claimed. The
unmet AC-UPD-003 / SEC-UPD-003 criterion requires expired, invalid and
unauthorized response links to neither reveal project information nor submit a
response. Existing repository, pure expiry, mocked HTTP and mocked browser tests
do not jointly prove the authenticated HTTP/database boundary. Packaged restore
tests do not currently start a restored API listener. OD-013/014 remain in force;
this work uses synthetic data and sends no external messages or Jira writes.

Add a qualified disposable PostgreSQL integration test using the actual Nest HTTP
listener, real synthetic-development `IdentityService` and signed JWTs, the real
database repository with `SET LOCAL ROLE pdaa_api`, and a guard-valid isolated
customer fixture. Exercise a valid recipient GET, response POST and identical
idempotent replay; compare the response/content count and preserve unconfirmed
state, facts, engagement, obligation and outbox. Then test GET and POST with
missing, forged, expired or wrong-audience tokens, malformed and unknown locators,
wrong subject, mismatched role, revoked grant, restricted source and a different
configured customer. Assert fixed generic errors, no-store, no sensitive response
data and no newly persisted denied response or content. Prove reauthorization on
replay. Avoid weekend-dependent conditional success and keep token and content
out of artifacts and logs. These tests use role switching on an owner connection,
not a separately authenticated production DB login or live OIDC.

The expired **invitation**, as opposed to an expired JWT, must be a guard-valid
persisted record and use the actual database clock. Do not wait 15 minutes,
disable triggers or modify a live environment. Review whether the existing
isolated historical archive fixture can provide it and whether a restored API
listener can be exercised without weakening quarantine or runtime privileges.
That packaged recovery boundary is separate from synthetic direct-repository
checks. If it cannot be safely exercised, retain the gap and do not claim full
SEC-UPD-003 or criterion acceptance. Obtain exact-candidate independent reviews,
hosted checks and post-merge evidence before any acceptance decision.

## Initial candidate checkpoint

The new registered synthetic integration file exercises the real HTTP listener
and role-switched repository for positive response/replay, identity and locator
denials, cross-customer configuration, source/grant revocation and a separate
guard-valid persisted-expiry fixture with a live same-owner peer. The expiry
fixture backdates the application setup clock and capture metadata for a
synthetic history; the actual authorization clock and SQL triggers stay active.
Its peer is a different stage kind, and it does not prove historical delivery.
Independent static fixture and security reviews found and corrected gate-clock,
responsibility, audit-snapshot, cross-tenant and body-validation test issues.
Local lint initially found an unused configuration variable; it was removed and
the affected lint passed. The native HTTP/database tests have not run locally:
no qualified disposable PostgreSQL server is available. Hosted execution,
restored-endpoint proof and exact-candidate review remain required. No acceptance
claim follows from this checkpoint.
