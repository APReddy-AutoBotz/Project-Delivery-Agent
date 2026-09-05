# Event Demo Scenario

## Purpose

Provide a short, memorable demonstration of the complete product value rather than a broad feature tour.

## Synthetic portfolio

### Project Atlas

- Reported RAG: Green
- Baseline go-live: 15 October 2026
- Forecast go-live: 29 October 2026
- Critical milestone: Integration testing
- Blocker: API access
- Jira issue: ATLAS-248
- Responsible owner: Developer A
- Project manager: Maria Project
- Sponsor: Alex Executive
- Latest PM update: More than seven days old

### Project Draco

- Provides the API dependency
- Dependency delivery has slipped
- Its own Jira record shows an unresolved access approval
- The dependent Atlas status has not yet acknowledged the slip

## Demonstration flow

### 1. Portfolio view

Show:

- Atlas reported Green
- Update freshness overdue
- Critical blocker open
- Dependency signal
- Calculated Amber or Red signal separate from reported Green

### 2. Contextual request

Open the prepared request:

> ATLAS-248 remains blocked and integration testing is due to start. Your previous update said API access was expected on 4 September. Has access been received? If not, provide the current owner, expected access date and impact on testing.

### 3. Human response

Use:

> Access is still pending from Infrastructure. They expect to provide it on Wednesday. I need two working days after access to complete the integration task.

### 4. Structured interpretation

Show:

- Status: Blocked
- Blocker: API access pending
- External owner: Infrastructure
- Expected access: Wednesday
- Work duration after access: two working days
- Forecast impact: proposed
- Classification: Awaiting confirmation

### 5. Confirmation and approval diff

Confirm the interpretation and show the PM:

- Existing Jira comment/state
- Proposed comment
- Optional allowlisted field change
- Original response
- Evidence
- Notifications
- Approval

### 6. Safe write

Approve the Jira comment. Show:

- Preflight source revision
- Successful action receipt
- Jira deep link
- Audit entry

### 7. PM recommendation

Show:

> API access has been unresolved beyond the configured threshold and threatens integration testing. Escalate to the Infrastructure Manager today and reconfirm the 29 October forecast after access is granted.

### 8. Leadership question

Ask:

> Why is Project Atlas delayed, and are we confident in the new date?

Expected answer:

- States baseline and forecast difference
- Identifies API access as human-confirmed cause
- Shows Jira blocker and owner response evidence
- States action taken
- States that the forecast remains medium confidence until access is received
- Notes that the PM update was previously stale but has now been refreshed

### 9. Publishing

Show:

- Refreshed live project
- Leadership digest preview
- Generated PowerPoint slide
- Same snapshot ID/fact set

## Demo duration

Target 5 to 7 minutes.

## Demo safety

- Synthetic names and data
- Dedicated Jira demo site
- No customer credentials
- Reset script
- Shadow-mode fallback
- Pre-generated report fallback if external systems are unavailable
