# Failure and Recovery Tests

| ID | Scenario | Expected recovery |
|---|---|---|
| FAIL-001 | Jira OAuth token expired | Refresh atomically or mark connector failed; no secret exposure |
| FAIL-002 | Jira refresh token invalid | Stop sync/write and create admin action |
| FAIL-003 | Jira rate limited | Honor retry interval and preserve job state |
| FAIL-004 | Duplicate webhook | One observation and no duplicate obligation |
| FAIL-005 | Webhook missed | Scheduled reconciliation recovers current state |
| FAIL-006 | Spreadsheet row identity changes | Preview conflict; do not silently duplicate project |
| FAIL-007 | AI output invalid JSON/schema | Retry bounded or route to manual structuring |
| FAIL-008 | AI provider timeout | Preserve response and continue deterministic functions |
| FAIL-009 | Source conflict | Mark CONFLICTING and request reconciliation |
| FAIL-010 | User response ambiguous | Clarification, no material write |
| FAIL-011 | User responds after escalation | Stop future reminders and record timing |
| FAIL-012 | Worker restarts mid-workflow | Durable state resumes without duplicate action |
| FAIL-013 | API restarts during approval | Approved proposal persists and is executed once |
| FAIL-014 | Jira changes after approval | Preflight blocks and new approval required |
| FAIL-015 | Write response lost after source committed | Reconcile source before retry |
| FAIL-016 | PowerPoint generation fails | Report run remains failed/retryable; no false final status |
| FAIL-017 | Database backup restore | Recovered facts, obligations and receipts remain consistent |
| FAIL-018 | Unauthorized evidence deep link | Deny without confirming hidden content |
| FAIL-019 | Prompt injection in source | Ignore instruction and record safe processing |
| FAIL-020 | Shadow mode enabled | No outbound message or write endpoint called |
| FAIL-021 | SMTP/email delivery failure | Retry safe failure and show delivery state |
| FAIL-022 | Wrong recipient mapping | Block send if identity confidence is insufficient |
| FAIL-023 | Time-zone configuration invalid | Reject configuration with actionable error |
| FAIL-024 | Migration fails | Stop release, preserve backup and follow recovery runbook |

## Unknown write outcome

This is a critical scenario.

1. The connector sends a write.
2. The network fails before the product sees the response.
3. The product must not blindly retry.
4. It must query the current source using the idempotency marker, expected value or receipt metadata.
5. If the write already occurred, record success.
6. If it did not occur and retry is safe, retry once according to policy.
7. Otherwise create a manual recovery item.
