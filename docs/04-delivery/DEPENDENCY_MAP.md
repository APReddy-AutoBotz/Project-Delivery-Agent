# Release 1 Dependency Map

```mermaid
flowchart TD
    F[EPIC-01 Foundation] --> C[EPIC-02 Connectors]
    F --> M[EPIC-03 Canonical Model and Evidence]
    C --> M
    M --> H[EPIC-04 Health and Contradictions]
    M --> U[EPIC-05 Update Engagement]
    F --> U
    U --> A[EPIC-06 Interpretation, Approval and Write-back]
    C --> A
    M --> A
    H --> V[EPIC-07 Advice and Action Queues]
    U --> V
    A --> V
    M --> Q[EPIC-08 Leadership Q&A]
    H --> Q
    A --> Q
    Q --> R[EPIC-09 Dashboards and Reports]
    V --> R
    F --> S[EPIC-10 Security and Deployment]
    C --> S
    A --> S
    R --> S
```

## Critical path

1. Platform foundation
2. Jira/spreadsheet ingestion
3. Canonical facts and evidence
4. Update obligations
5. Response interpretation and confirmation
6. Approval and Jira write-back
7. Leadership Q&A
8. Dashboard and management snapshot
9. Security and release hardening

## Parallel opportunities

After the foundation:

- Jira connector and spreadsheet connector
- Evidence model and basic web shell
- Health rules and update-message UX after the canonical model
- PowerPoint template and leadership Q&A UI after claim schema is stable
- Security tests throughout rather than at the end

## Hard dependencies

- No leadership answer before fact classification and authorization.
- No write-back before approval, preflight and action receipt.
- No escalation before update-obligation state is durable.
- No final report before report-run fact-set revision exists.
- No customer deployment before backup, restore and secret configuration are documented.
