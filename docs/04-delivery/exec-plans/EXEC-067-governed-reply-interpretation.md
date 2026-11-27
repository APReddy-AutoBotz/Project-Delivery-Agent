# EXEC-067 Governed reply interpretation

Issue #10, STORY-020, FR-ADM-007, TR-AI-001, TR-AI-004,
NFR-PRV-001 and AC-AI-002. ADR-004 governs the provider boundary.

Add an optional interpretation action to the existing capture review. Start
with one active response and the status and forecast fields already supported
by human confirmation. Use the same project, reviewer, retention and source
checks as capture review before and after the provider call. Run the provider
outside repository transactions. Treat the reply as untrusted data.

Use a first-party structured interface shared by a deterministic fixture and
an operator-configured private endpoint. The initial routing policy permits an
explicitly enabled local synthetic development or test configuration. The
request carries the retained response text and the supported field types. Use a
bounded request and a strict response schema with references to exact reply
text. Expose accepted proposals as agent
inference and route confirmation through the existing review. Manual entry and
the current deterministic suggestions cover unavailable and uncertain results.

Use existing audit storage for provider, model, prompt and schema revisions
and the bounded outcome. Verify exact reviewer scope, one approved request
shape, invalid output and timeout fallback through the same interface. Customer
routing and a real endpoint acceptance require configured data policy and
provider access. Recovery disables interpretation in deployment configuration.

For local synthetic use, set `PDAA_REPLY_INTERPRETATION_FILE` to a JSON file
with `dataClass` set to `SYNTHETIC_INTERNAL`, the approved HTTPS `endpoint`
ending in `/chat/completions`, the `model`, and `bearerFile` pointing to an
operator-owned secret file. The request uses the provider's JSON-object
response format and the repository validates the result against the reply.
