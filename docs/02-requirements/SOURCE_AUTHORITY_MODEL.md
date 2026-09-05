# Source Authority Model

## Principle

There is no single universal source of truth for every project fact. The product must define authority at field or fact-type level.

## Authority rule

An authority rule contains:

```text
Customer
Scope
Canonical fact type
Authoritative source type
Optional source instance
Required approval state
Freshness period
Fallback sources
Conflict behavior
Effective date
```

## Example authority matrix

| Fact type | Primary authority | Secondary evidence | Conflict behavior |
|---|---|---|---|
| Jira work-item status | Jira | Owner update | Jira remains current status; owner response may create proposed change |
| Sprint assignment | Jira Agile | PM plan | Mark conflict if plan differs |
| Project baseline date | Approved baseline record | Jira milestone | Do not overwrite without change control |
| Project forecast date | PM-approved portfolio record | Jira due dates and owner updates | Ask PM to reconcile |
| Budget | Approved finance or PPM source | Spreadsheet estimate | Never infer from delivery data |
| Reported project RAG | PM-approved status | Portfolio record | Retain reported value |
| Calculated delivery signal | Health engine | Source facts | Show separately from reported RAG |
| Delay cause | Latest authorized human confirmation with evidence | Issue comments, meeting actions | Label attribution and freshness |
| Risk state | Approved RAID register | Jira and communication signals | Candidate unlogged risk if absent |
| Final reporting snapshot | Approved application snapshot | Current live facts | Snapshot remains historical |

## Resolution algorithm

1. Identify the requested canonical fact.
2. Load active authority rule for the project scope.
3. Retrieve candidate values and source metadata.
4. Exclude unauthorized or invalid evidence.
5. Check required approval state.
6. Check freshness.
7. Select the authoritative current value when the rule clearly permits.
8. Retain secondary values as evidence.
9. If two applicable authoritative values disagree, mark `CONFLICTING`.
10. Do not let the LLM select the authoritative value.

## Freshness

Example default periods, configurable by customer:

| Fact type | Example validity |
|---|---:|
| Work-item status | 24 hours after sync |
| Blocker statement | 3 business days |
| Project status narrative | 7 days |
| Forecast date | Until changed or reporting due |
| Delay cause | Until the next material update |
| Risk mitigation | 7 days for critical risk |
| Budget | Until the next approved financial refresh |

## Human confirmation

A human-provided fact is valid only when:

- The person is authorized or is the configured responsible owner.
- The statement is mapped to a specific project or record.
- The product retains the original response.
- Any ambiguity is resolved.
- Higher-authority evidence does not contradict it.
- The confirmation remains within its validity period.

## Conflict example

```text
Portfolio spreadsheet:
Milestone = Complete

Jira:
Three mandatory linked issues = Open

Result:
Milestone status = CONFLICTING
Action:
Request project-manager reconciliation
Leadership wording:
"The milestone is reported complete, but three mandatory linked Jira items remain open. Completion is not verified."
```

## Source deletion and access changes

If evidence is deleted or the user loses access:

- Retain permitted metadata and audit history.
- Do not expose content no longer authorized.
- Mark dependent claims for revalidation if the evidence can no longer be verified.
- Follow customer retention and legal policy.
