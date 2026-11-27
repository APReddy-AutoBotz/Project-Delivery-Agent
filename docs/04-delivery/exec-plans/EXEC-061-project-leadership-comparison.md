# EXEC-061: Compare a selected project with a saved snapshot

Status: In Progress
Requirement IDs: FR-QA-002, FR-QA-006, FR-QA-010 and FR-QA-012.
GitHub issue: [#12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12).
Target release: R1
Last updated: 2026-11-27

## Scope and design

Let a leader compare the selected project's current canonical schedule and
authorized saved freshness with a prior report snapshot selected by ID. Extend
the existing read-only leadership answer and use the existing saved report
read, including its project, author and source access checks. Display changes
in dates, freshness, update source date and outstanding update status with
both as-of times and the exact schedule and assessment references. Ignore a
change to the assessment ID alone when reporting material differences.
Use the approved label on the downloaded file for an approved snapshot.

The controls select one exact saved snapshot for the current project. General
time-range parsing, portfolio comparison, and causal explanation remain
separate work. No data migration, dependency or connector scope change.

## Verification and recovery

Extend the existing hosted browser journey to compare before and after an
active policy change, reject missing and wrong-project IDs, and deny a PM
access to the leader's report. Verify the existing current schedule answer,
the wire response and the actual approved PowerPoint download.
Revert the answer extension to remove the comparison control.
Saved reports and earlier audit entries remain available through their existing
authorized routes.
