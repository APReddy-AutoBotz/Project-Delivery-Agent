# EXEC-031: Bounded milestone question routing

Status: Provisional local implementation under independent review; no publication,
merge or acceptance is claimed. This is a partial step toward FR-QA-001/002/004/005/007/008/012,
STORY-027/028/029 and GOLDEN-003. PR #124's milestone observation is a dependency; its exact candidate checks
passed and its verified actual merge has post-merge checks in progress. No story, criterion or release hold
is accepted by this plan. OD-013/014 and the stop on Original19/20 capture remain
in force.

## Outcome and scope

Allow a leadership user in one already authorized project to ask a small,
explicitly supported set of natural-language questions about one milestone they
select from the current successful canonical project view. Route an accepted
question to the current `leadership-conflict-observation` and render its bounded
positions and evidence. If the fixed rule finds no contradiction, say only that
it found none for that milestone at the observed time; do not claim the milestone
is complete or that other conflicts are absent. If the observation is unavailable,
report that current access or evidence could not be established. Questions outside
the supported forms receive a fixed explanation of the supported question and
their submission causes no observation or other project-data call.

This is a deterministic narrow router, not broad natural-language understanding,
a model, a history search, a time-period resolver, a change/why-delay answer, a
project-wide conflict search or a complete Q&A product. It does not satisfy the
full FR-QA-001/002/006/009 or GOLDEN-003 by itself. It cannot infer source names,
Jira or sheet origin, human presence, update-request state, project-wide health,
causality or actual reconciliation. It does not create a request, send a message,
write a comment, or change canonical facts. The existing API remains the source
of truth; do not store derived narratives as facts or add an outgoing AI call.

## Input and privacy boundary

Project identity comes only from the authenticated, currently visible project
view, and milestone identity only from the currently loaded canonical selector.
No free-text parsing resolves project, milestone, period, scope, actor, source,
role or authorization. After rejecting input longer than 200 UTF-16 code units,
reject any character except ASCII letters, U+0020 space, ASCII apostrophe and
question mark. Do not rely on HTML `maxLength` truncation: a long paste or edit
must be rejected as a whole before a truncated accepted prefix can be submitted.
Bound the controlled state and reject oversized input attempts, including paste
and composition paths, rather than storing or silently clipping them. This
rejects controls (including tab/newline), Unicode confusables
and all surrogate code units before normalization. Trim and collapse U+0020
spaces only, fold ASCII A–Z to a–z, then remove at most one terminal `?` and
any single normalized trailing space immediately before it. Match exactly one
of these complete normalized strings:

- `does the selected milestone's recorded completion conflict with required work`
- `is there a conflict between the selected milestone's completion and required work`
- `does the selected milestone completion conflict with required work`

For example, an accepted phrase with mixed ASCII case, surrounding spaces and
one final question mark is equivalent to its lowercase form. Show at least one
exact accepted question beside the input before submission so the limited grammar
is discoverable. Explain there that the rule checks recorded COMPLETE against
required OPEN or IN_PROGRESS work and cannot establish completion. Empty input, extra
punctuation, doubled question marks, quotation marks, multiple questions,
instructions, negation, periods/dates, time qualifiers, names or project/source
labels are unsupported. Do not use substring matching, fuzzy matching or an LLM;
never interpret unrecognized text as authority expansion. Unsupported input causes
no observation request or other project-data call as a consequence of that
submission; independent existing panels and canonical revalidation may still run.

Accept plain text only, and do not interpolate or echo submitted text into the
answer or errors. Keep input in component memory only. Application code must not
put it in URLs, network requests, logs, analytics, local/session storage, audit
events, model prompts or database records; this is not a guarantee about browser,
IME, extension or platform instrumentation. Prevent default form submission so
no query-string GET can contain the text, and disable autocomplete and spellcheck
where supported. The existing observation GET takes only server-selected IDs;
send it only after an explicit submit of an accepted phrase, and use the current
project and selected milestone. Do not add an endpoint accepting user question
text in this slice. Every edit, invalid submission, scope change or unmount must
immediately clear the old answer, invalidate the accepted submission generation
and abort/dispose the associated in-flight request and scheduled refresh timer; an abort-resistant late result
must never restore evidence for edited or rejected text.

The input and previous answer must clear or disappear on logout, identity
refetch/error, role removal, project change, canonical view refetch/failure and
selection change. On a milestone selection change retain the newly selected
milestone while clearing the previous question and answer and invalidating its
request generation; otherwise the user cannot choose a target. Abort/dispose in-flight requests and reject
late responses by current session/project/milestone/question generation. Refresh
and focus/visibility revalidation must hide the prior answer before rechecking;
no question-flow request may occur before the first supported submission.
Replace the existing EXEC-030 panel's automatic on-selection request in the
question flow with this explicit-submit gate; selecting or focusing alone must
not fetch an observation. Avoid a second duplicate panel that separately fetches
the same observation. The server's
current role, scoped grant, target visibility and all-version source-reader checks
remain mandatory for every accepted request. An inaccessible source must not be
turned into a non-conflict answer, and failure bodies must not reveal hidden IDs,
counts or labels. Accessibility requires a labeled input, a submit button, a
visible bounded input limit and live status/error messages.

## Evidence and claim handling

Use the exact, strict, currently authorized observation response and the same
presentation decoder rather than reimplementing authority selection. Evidence
references remain position-specific: version, evidence and source IDs, stored
provenance, policy revision and observed/validity instants are displayed only as
provided by the authorized response. The cross-object contradiction is a fixed
rule result, not a human assertion or model inference. Separate the stored origin
labels from claims of independent human or system verification; no unsupported
fact may be inferred from a key, URL or template. `NOT_DETECTED` carries no
positions and has only rule-scoped meaning. If input, result, identity, target or
response parsing is invalid, show a fixed unavailable or unsupported message and
no stale evidence.

## Required verification and review

Before coding, independent reviewers must assess the fixed question grammar,
non-persistence, injection and authorization boundaries, and identify whether
this partial user experience is useful and truthful. Provisional local implementation may begin on the exact independently reviewed
PR #124 candidate tree while its hosted gates run. Before publication or merge,
reconcile to the verified actual PR #124 merge and rerun affected checks,
preserving its canonical view and scoped API. Tests must cover accepted and rejected forms, ambiguous or
multi-project text, time qualifiers, Unicode and surrogate/control boundaries,
length limits including oversized paste/composition that starts with a valid
phrase, no network for rejected input and no raw question in recorded
requests or logs. Browser tests must exercise pending identity and role changes,
project and selection changes, focus revalidation, denied access, late results
(including explicitly whether cancellation prevented delivery), successful
conflict and rule-scoped no-conflict presentation. A real role-switched
synthetic HTTP path should confirm the existing source and grant checks still
apply. Compare checked claims and exact evidence IDs to the prior observation;
all invalid/inaccessible results remain unavailable rather than fabricated.

Pin and independently review the exact source and tests, run appropriate local
checks, then use the normal hosted Foundation/Documentation, expected-head merge,
actual merge/tree and post-merge evidence gates. Preserve all failed attempts.
This slice remains partial even if its own checks pass. Full Q&A still requires
broader question/period resolution, unanswered-state coverage, current source
freshness and unresolved update context, model/output safety if a model is used,
all shared golden-scenario evidence and the release gates.


## Local checkpoint

A provisional local implementation replaces automatic milestone reads with the
explicit question submission and the reviewed fixed grammar. Local grammar tests,
web type checking and lint passed. An isolated mocked Chromium run passed real
clipboard newline and oversized-paste cases, a Chromium DevTools composition
sequence with an oversized insertion, source-denial display, project and
canonical-view changes, identity refetch/role removal, and held responses for
both selection and question edits. The held-response harness disables abort,
identifies each response by a unique synthetic header and waits for its body to
reach the browser before checking that stale evidence stays hidden. The mocked
positions' policy, evidence, version, source, state and timing are compared to
exact fixture values. It also checks intercepted API requests and point-in-time console and storage for a
synthetic question canary. These are mocked browser observations, not broad claims about browser
extensions, a physical operating-system IME or independent authentication.

PR #124's reviewed head `edc70c71f0702f6136aa52da09672a83289cf26a` passed
Foundation 40944539384 and Documentation 40944539318. It merged as
`9386d96f8470fe8f2db881884f6bf0f034e5ae78` with the reviewed tree
`f790111509770a18bcc4ceea2f6149f2a9ae1791` and expected ordered parents.
Actual post-merge Foundation 40948055073 and Documentation 40948055192 were
queued at this checkpoint. The follow-up's local base `40e88fd` has that same
tree, so the already-run affected local checks apply to the reconciled source;
the actual post-merge and follow-up hosted gates remain required before merge. Broader Q&A and
GOLDEN-003 remain open.
