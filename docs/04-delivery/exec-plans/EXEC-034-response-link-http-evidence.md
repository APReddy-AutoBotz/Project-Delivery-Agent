# EXEC-034: Real response-link denial evidence

Status: Reviewed PR #127 merged after current-base and actual post-merge hosted
checks passed; no acceptance is claimed. The
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
no qualified disposable PostgreSQL server is available. Initial hosted Foundation
40958959457 and Documentation 40958959430 passed on reviewed head
`a7d4afdd8df30f24e64bdc32873f16bcfdb14e91`. After retargeting to the verified
main merge of PR #126, its GitHub merge preview remained stale. The branch was
refreshed without changing its tree: head `7abc5a38ac6b2a74a6c600185b6c223d21c5cab2`
has reviewed tree `e84393639d14f6fad86325b27bafef1f5ce490ae`, and current
preview `3a2771e3635bdff80c055f12b829a7412ca70637` has that tree and ordered
parents `3c59ea981c023b76af9e2bd535e7d22fefe96d8f`, then refreshed head.
Independent provider review confirmed the exact five-file diff and tree; fresh
Foundation 40963155930 and Documentation 40963155935 passed. Actual merge
`941113241b75fb1f99c6031c9fa9d93a1aa1adc4` has reviewed tree
`e84393639d14f6fad86325b27bafef1f5ce490ae` and ordered parents
`3c59ea981c023b76af9e2bd535e7d22fefe96d8f`, then refreshed head. Its
post-merge Documentation 40966514510 and Foundation 40966514743 passed.
An earlier CRLF-converted preparation created an unreferenced tree object
`b64060d54f28c37fa14d97dfe9a255ee95119f63`; the branch was created only after
the exact blob-based tree matched. Restored-endpoint proof remains required and
no acceptance claim follows from these tests.
