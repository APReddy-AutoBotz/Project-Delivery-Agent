# Use Case Catalog

| ID | Use case | Primary actor | Release |
|---|---|---|---|
| UC-001 | Connect a Jira Cloud site with least-privilege access | Administrator | R1 |
| UC-002 | Import and map a project portfolio spreadsheet | PMO Administrator | R1 |
| UC-003 | Detect that a project update is overdue | System | R1 |
| UC-004 | Ask the responsible person a contextual update question | Agent | R1 |
| UC-005 | Send reminder and escalate a continued non-response | Agent, PM | R1 |
| UC-006 | Capture a free-text project update | Contributor | R1 |
| UC-007 | Extract structured facts and proposed changes from the reply | Agent | R1 |
| UC-008 | Review and correct the extracted interpretation | Contributor or PM | R1 |
| UC-009 | Approve a material Jira update through an approval diff | PM | R1 |
| UC-010 | Write an approved comment or safe field change to Jira | System | R1 |
| UC-011 | Create an action receipt for the external write | System | R1 |
| UC-012 | Detect a stale blocker or overdue critical item | System | R1 |
| UC-013 | Recommend an intervention to the PM | Agent | R1 |
| UC-014 | Ask why a project is delayed | Leadership | R1 |
| UC-015 | Answer using verified facts, uncertainty and evidence links | Agent | R1 |
| UC-016 | View portfolio freshness and missing updates | PMO | R1 |
| UC-017 | Generate a leadership PowerPoint or PDF snapshot | PMO | R1 |
| UC-018 | Run all monitoring in shadow mode | Administrator | R1 |
| UC-019 | Detect a source conflict and request reconciliation | System, PM | R1 |
| UC-020 | Restrict a user to authorized projects and portfolios | System | R1 |
| UC-021 | Process replies from a Microsoft 365 shared mailbox | System | R2 |
| UC-022 | Send and receive updates through Microsoft Teams | Agent, user | R2 |
| UC-023 | Retrieve approved evidence from SharePoint or OneDrive | System | R2 |
| UC-024 | Detect a cross-project dependency slip | System | R3 |
| UC-025 | Detect green status that conflicts with delivery signals | System | R3 |
| UC-026 | Identify a risk discussed informally but absent from RAID | System | R3 |
| UC-027 | Provide a portfolio-level intervention briefing | PMO, Leadership | R3 |
| UC-028 | Connect ClickUp, Trello, monday.com or Asana | Administrator | R4 |
| UC-029 | Expose controlled PMO tools through MCP | External assistant | R5 |
| UC-030 | Exchange initiative and outcome status with AvalaOS | Product integration | Future |

## Detailed hero use case: UC-003 to UC-015

### Trigger

A project status update is overdue, and Jira shows an unresolved blocker near a critical milestone.

### Main flow

1. The monitor detects that the project update is outside its freshness window.
2. The product gathers approved current context from Jira and the portfolio record.
3. It identifies the missing information: blocker resolution date and milestone impact.
4. It sends the task owner a focused update request.
5. The owner responds in free text.
6. AI extracts a proposed blocker update and revised forecast.
7. The owner or PM reviews and corrects the interpretation.
8. The product creates an approval diff.
9. The PM approves a Jira comment and selected field change.
10. The product re-checks the source record and performs the write.
11. It records an action receipt.
12. The health engine recalculates the project signal.
13. The advisor recommends an escalation or recovery action.
14. Leadership asks why the milestone is delayed.
15. The answer identifies verified cause, impact, action, remaining uncertainty and evidence.

### Alternate flows

- Owner does not respond: reminders and PM escalation follow policy.
- Reply is ambiguous: the product asks a follow-up question.
- Jira value changed after approval: the write is blocked and a new diff is required.
- Sources conflict: the product marks the fact as `CONFLICTING`.
- User lacks project access: no project facts are returned.
- AI is unavailable: the response is queued for manual structuring and deterministic monitoring continues.
