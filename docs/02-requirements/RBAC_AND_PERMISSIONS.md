# RBAC and Permissions

## Principles

- Deny by default.
- Enforce authorization on the server.
- Separate application permission from connector permission.
- Restrict users to authorized portfolios, programmes, projects and evidence.
- A user who can read a project does not automatically have authority to approve or write.
- AI tools act only within the initiating user or approved service-policy scope.
- Scheduled actions use an explicitly configured service identity and policy.

## Standard roles

| Role | Primary purpose |
|---|---|
| Leadership | Read executive project and portfolio information; review decisions requiring their role |
| Sponsor | Read assigned project details and approve sponsor-level decisions |
| PMO Administrator | Configure portfolio structures, policies, mappings, templates and access |
| Portfolio Manager | Manage permitted portfolios and approve portfolio reporting |
| Project Manager | Manage assigned projects, approve selected updates and initiate follow-up |
| Scrum Master | Review sprint delivery signals and coordinate team follow-up |
| Team Lead | Review team-level dependencies, ownership and technical actions |
| Contributor | Respond to update requests and view permitted assigned context |
| Read-only Stakeholder | View permitted current and approved information |
| System Administrator | Operate deployment, identity, secrets and connectors without implicit business access |
| Auditor | Read approved audit and evidence records within assigned scope |

## Permission matrix

Legend: `R` read, `C` create, `U` update, `A` approve, `X` execute, `-` no default permission.

| Capability | Leadership | PMO Admin | Portfolio Mgr | PM | Scrum Master | Team Lead | Contributor | Sys Admin | Auditor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| View permitted portfolio | R | R | R | R | R | R | Limited | - | R |
| View permitted project | R | R | R | R | R | R | Limited | - | R |
| View supporting evidence | R | R | R | R | R | R | Limited | - | R |
| Ask leadership Q&A | R | R | R | R | R | R | Limited | - | R |
| Configure source connector | - | C/U | - | - | - | - | - | C/U | R |
| Configure field mapping | - | C/U | C/U | Limited | - | - | - | - | R |
| Configure cadence | - | C/U | C/U | Project | - | - | - | - | R |
| Send manual update request | - | C | C | C | C | C | - | - | R |
| Respond to own request | - | - | - | R | R | R | C/U | - | R |
| Approve project narrative | - | A | A | A | Limited | - | - | - | R |
| Approve Jira comment | - | A | A | A | Configured | Configured | - | - | R |
| Approve forecast change | - | A | A | A | - | - | - | - | R |
| Execute approved write | Policy | Policy | Policy | Policy | Policy | Policy | - | Service | R |
| Approve final portfolio report | A if configured | A | A | - | - | - | - | - | R |
| View audit records | Limited | R | Limited | Project | Limited | Limited | Own | Operational | R |
| Manage users and role mapping | - | C/U | - | - | - | - | - | C/U | R |
| Configure AI provider | - | Policy | - | - | - | - | - | C/U | R |
| Enable shadow mode | - | C/U | - | - | - | - | - | C/U | R |

## Scope model

Permissions apply at one or more levels:

```text
Customer deployment
  -> portfolio
     -> programme
        -> project
           -> work item and evidence
```

A role assignment must include scope. Example:

```text
Role: Project Manager
Scope: Project Alpha
```

A global “Project Manager” role must not grant access to unrelated projects.

## Approval separation

The system must support separation between:

- Request creator
- Information provider
- Proposal reviewer
- Approver
- Executing service identity
- Auditor

A small customer may configure one person for several responsibilities, but the action receipt must preserve each capacity.

## Scheduled agent permission

A scheduled job may:

- Read configured sources
- Calculate deterministic signals
- Draft questions and reports
- Send approved classes of reminders
- Create internal proposals

It may not exceed the configured service policy or use the permissions of the last interactive user.

## Evidence permissions

Evidence access must be checked independently from answer access. If a user may see a summarized status but not a confidential source document, the answer must not expose the confidential content or deep link.

## Administration without business access

System administrators may manage deployment health, connectors and secrets without automatically receiving access to project content. Operational logs must be redacted accordingly.
