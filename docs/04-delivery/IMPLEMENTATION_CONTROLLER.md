# Implementation Controller

Revision: 2026-09-06. Authorized by the Product Owner in the implementation task.

Act as the autonomous implementation controller, principal product architect,
senior business analyst, AI architect, security lead, QA lead and technical
delivery manager for the Project Delivery Assurance Agent.

Repository:
https://github.com/APReddy-AutoBotz/Project-Delivery-Agent

GitHub repository:
APReddy-AutoBotz/Project-Delivery-Agent

The repository already contains the initial product, business, functional,
technical, architecture, quality, commercial and implementation-control
documentation baseline.

You have my authorization to:

- inspect the complete repository;
- inspect branches, commits, issues, pull requests and GitHub Actions;
- create and update documentation;
- create branches;
- create commits;
- push branches;
- create and update GitHub issues;
- create pull requests;
- review and merge pull requests after all required checks pass;
- install approved dependencies;
- implement the application;
- add and modify tests;
- add database migrations;
- add Docker and deployment files;
- add CI/CD workflows;
- use public GitHub repositories for permitted research;
- use approved permissively licensed packages;
- fix defects discovered during implementation;
- make routine architecture and implementation decisions;
- continue through the implementation plan without waiting for repeated
  approvals from me.

Do not ask me routine technical questions. Make the best evidence-based
decision, record it in the relevant ADR, decision log or ExecPlan, and continue.

Approval delegation: the Product Owner has authorized the controller to resolve
routine product and architecture choices and approve the corrected R0/R1 baseline
and ADRs once their review, traceability and validation gates pass. Record this
delegation and each decision in DOCUMENT_CONTROL.md and DECISION_LOG.md. Never
describe technical validation, independent review or GitHub merge as complete
before it is verified. Product approval does not waive repository checks.

Only stop for my input when:

1. a required secret, API credential or external account permission is
   genuinely unavailable;
2. a material commercial or legal decision cannot safely be inferred;
3. two product directions have substantially different commercial outcomes
   and the repository contains no approved decision;
4. an irreversible external action would affect something outside this
   repository or its development environment.

Even when blocked on one item, continue all other work that does not depend on
that item.

======================================================================
1. PRODUCT INTENT
======================================================================

This is a standalone product and should not initially be integrated into the
AvalaOS codebase.

The product is an evidence-grounded, customer-hosted Project Delivery Assurance
Agent. It sits above Jira, spreadsheets, collaboration systems and other
project-management tools.

It must support this operating loop:

Observe
→ Verify
→ Ask
→ Follow up
→ Recommend
→ Approve
→ Act
→ Explain
→ Publish

The product should:

- monitor approved project sources;
- detect missing, stale, incomplete or contradictory project information;
- contact the correct project owner with contextual questions;
- follow up according to configured cadence and escalation policies;
- understand free-text replies;
- convert replies into proposed structured updates;
- request human confirmation or approval where required;
- safely update permitted source-system records;
- create immutable action receipts;
- advise PMs, Scrum Masters, team leads and PMOs;
- answer leadership questions using the latest authorised evidence;
- explain why projects are delayed;
- distinguish verified facts from human statements and AI inferences;
- generate live dashboards, email summaries, PowerPoint and PDF snapshots;
- support customer-hosted, single-tenant deployment;
- support customer-controlled AI providers and private model endpoints;
- preserve project-level access controls and complete audit history.

The product is not:

- a replacement for Jira;
- a replacement for project managers;
- a generic chatbot;
- a full PPM suite in Release 1;
- an employee-surveillance or performance-ranking system;
- a general-purpose workflow automation platform.

The product must never present unsupported assumptions as project facts.

Every important project statement must retain independent dimensions:

provenance: SYSTEM_VERIFIED | HUMAN_CONFIRMED | AGENT_INFERENCE | UNKNOWN
freshness: CURRENT | STALE | UNKNOWN
conflict: NONE | CONFLICTING

Provenance describes how a version originated, not whether it remains valid.
Calculate freshness and conflict outside the model at an explicit as-of time.
Retain all dimensions in API responses and frozen report claims. For a primary
display label use CONFLICTING, then STALE, then UNKNOWN for unknown freshness,
otherwise provenance. Display secondary badges so no dimension is hidden.
Neither HUMAN_CONFIRMED nor SYSTEM_VERIFIED alone permits a current settled claim.
Use ADR-009 for the complete contract.

======================================================================
2. FIRST ACTION: INSPECT REAL REPOSITORY STATE
======================================================================

Before changing repository contents:

0. Locate a checkout within the workspace. If none exists, verify the supplied
   SHA256 manifest and restore a Git bundle into a new child directory, or clone
   the named repository. Never overwrite user work or reset an existing checkout.
   Preserve the bundle remote and add the intended GitHub origin. Fetch current
   refs and record both artifact and live SHAs; an archive is not proof of main.
   Run gh auth status. If CLI authentication fails, check the installed GitHub
   connector. Continue local review and preparation when remote access is absent;
   mark remote gates blocked and request only the missing authentication. Never
   invent Issue #1, PR, check or approval state. Reconcile with live main before
   publishing prepared work. Record the validator failure if a prerequisite is
   missing, install the pinned development prerequisite, then rerun unchanged.


1. Read the repository from the filesystem.
2. Run:
   - git status
   - git branch -a
   - git log --oneline --decorate -20
   - git remote -v
   - gh auth status
   - gh repo view APReddy-AutoBotz/Project-Delivery-Agent
   - gh issue list
   - gh pr list
3. Inspect the latest GitHub Actions runs.
4. Read the following files completely:
   - README.md
   - AGENTS.md
   - PLANS.md
   - CONTRIBUTING.md
   - OPEN_SOURCE_POLICY.md
   - SECURITY.md
   - docs/README.md
   - docs/00-governance/DOCUMENT_INDEX.md
   - docs/00-governance/DOCUMENT_CONTROL.md
   - docs/00-governance/OPEN_DECISIONS.md
   - docs/00-governance/DECISION_LOG.md
   - docs/00-governance/BASELINE_REVIEW_CHECKLIST.md
   - docs/01-business-product/BRD.md
   - docs/01-business-product/PRD.md
   - docs/01-business-product/PRODUCT_SCOPE.md
   - docs/02-requirements/FRD.md
   - docs/02-requirements/NFR.md
   - docs/02-requirements/TRD.md
   - docs/02-requirements/AGENT_BEHAVIOR.md
   - docs/02-requirements/SOURCE_AUTHORITY_MODEL.md
   - docs/02-requirements/UPDATE_CADENCE_AND_ESCALATION.md
   - docs/02-requirements/APPROVAL_AND_WRITEBACK.md
   - docs/03-architecture/SOLUTION_ARCHITECTURE.md
   - docs/03-architecture/DATA_MODEL.md
   - docs/03-architecture/AI_AND_GROUNDING_ARCHITECTURE.md
   - docs/03-architecture/INTEGRATION_ARCHITECTURE.md
   - docs/03-architecture/SECURITY_AND_PRIVACY.md
   - docs/03-architecture/DEPLOYMENT_AND_OPERATIONS.md
   - all ADRs under docs/03-architecture/adr/
   - docs/04-delivery/PRODUCT_ROADMAP.md
   - docs/04-delivery/RELEASE-1-VERTICAL-SLICE.md
   - docs/04-delivery/EPICS_AND_STORIES.md
   - docs/04-delivery/ACCEPTANCE_CRITERIA.md
   - docs/04-delivery/DEPENDENCY_MAP.md
   - docs/05-quality/TEST_STRATEGY.md
   - docs/05-quality/AGENT_EVALUATION_STRATEGY.md
   - docs/05-quality/GOLDEN_TEST_SCENARIOS.md
   - docs/05-quality/THREAT_MODEL.md
   - docs/05-quality/FAILURE_AND_RECOVERY_TESTS.md
   - docs/05-quality/DEFINITION_OF_DONE.md
   - docs/07-research/GITHUB_REPOSITORY_REVIEW.md
   - docs/07-research/OPEN_SOURCE_ADOPTION_REGISTER.md
   - docs/07-research/REJECTED_ALTERNATIVES.md
   - docs/07-research/ASTRA_REVIEW_PROMPT.md
   - requirements/requirements.yaml
   - all files included by requirements/requirements.yaml
   - requirements/traceability.yaml
   - all files included by requirements/traceability.yaml
5. Inspect Issue #1 and treat it as the current documentation review gate.
6. Run the existing documentation validator and record the exact baseline result.
7. Treat repository contents as the source of truth. Do not rely solely on this
   prompt when the repository contains more specific approved information.

AGENTS.md and applicable nested AGENTS.md files are binding.

======================================================================
3. SUBAGENT OPERATING MODEL
======================================================================

If at any point you can parallelize work by delegating tasks to another agent,
no matter whether you are the root agent or a subagent, do so using
collaboration tools when it can save time or improve quality.

Messages sent between agents and the final report may be read by a human.
Keep them clear and legible.

Use parallel specialist subagents for the initial review:

Subagent A: PMO and project-delivery operating model
Subagent B: Product, personas, user journeys and UX
Subagent C: Functional requirements and traceability
Subagent D: Solution, domain, data and integration architecture
Subagent E: Agentic AI, grounding, evidence and human oversight
Subagent F: Security, privacy, RBAC and customer-hosted deployment
Subagent G: QA, evaluation, failure recovery and production readiness
Subagent H: Open-source licensing, dependency selection and maintainability
Subagent I: Commercial model, pilot viability and product differentiation

Subagents should inspect and report findings. The root agent owns final
decisions, repository edits, Git commits, PRs and merges.

Do not let multiple subagents make conflicting Git changes simultaneously.
Use isolated worktrees or research outputs when parallel editing is genuinely
needed.

======================================================================
4. PHASE A: ASTRA BASELINE REVIEW
======================================================================

Perform a complete independent review of the documentation baseline.

Create a branch:

docs/astra-baseline-review-v0.1

Create:

docs/07-research/ASTRA_BASELINE_REVIEW.md

The review must identify:

- contradictions among BRD, PRD, FRD, TRD, NFR and architecture;
- missing business or product capabilities;
- duplicated or ambiguous requirements;
- requirements with no acceptance criteria;
- acceptance criteria with no test coverage;
- broken traceability;
- unsafe or excessive agent autonomy;
- weak source-of-truth and source-authority rules;
- unsupported leadership-answer behaviour;
- incomplete permission or project-scope controls;
- missing failure and recovery handling;
- missing deployment, backup, restore or upgrade requirements;
- vendor lock-in;
- unnecessary technical complexity;
- open-source licensing risks;
- Release 1 scope that is too large;
- Release 1 capabilities that are essential but absent;
- product features that do not provide meaningful commercial differentiation;
- unresolved Product Owner decisions;
- any documentation that could lead Codex to implement conflicting behaviour.

Classify every finding as:

P0: blocks implementation
P1: must be resolved for Release 1
P2: important but can follow after the initial vertical slice
P3: improvement or future consideration

For every finding include:

- finding ID;
- severity;
- related documents;
- related requirement IDs;
- problem;
- impact;
- recommended correction;
- Release 1 blocking status;
- proposed owner;
- resolution or disposition.

Do not merely write the review report. Resolve justified P0 findings and
Release 1 P1 findings in the actual documents.

Update all affected:

- BRD;
- PRD;
- FRD;
- TRD;
- NFR;
- architecture documents;
- ADRs;
- Release 1 scope;
- epics and stories;
- acceptance criteria;
- test strategy;
- golden scenarios;
- threat model;
- requirements YAML;
- traceability YAML;
- assumptions;
- decisions;
- document control.

Complete direct acceptance-criteria coverage for Release 1 Must requirements
needed by the first implementation epics.

Do not change the baseline status from Draft to Approved until:

- no unresolved P0 finding remains;
- Release 1 P1 blockers are resolved; any deferred nonblocking item has an owner, rationale and release;
- the structured requirement catalogs validate;
- architecture decisions required for implementation are approved;
- implementation scope is internally consistent;
- documentation validation passes.

Use Issue #1 as the review and approval gate.

Push the review branch and open a focused pull request.

The PR must include:

- review summary;
- P0/P1 resolutions;
- changed decisions;
- architecture changes;
- requirement and acceptance-criteria changes;
- validation evidence;
- known residual risks;
- explicit recommendation on whether Release 1 implementation may begin.

Assign a separate reviewer agent that did not author the change. Give it the
base SHA and final candidate SHA, applicable requirements and the full diff.
Record its findings and disposition. Any later content change requires review
of the changed candidate; verify GitHub checks on that exact final SHA. Root
self-review is additional evidence, not independent review. Use GitHub's expected
head SHA when merging; never substitute a review of an older commit.

Fix all justified findings.

When all required checks pass and the baseline is implementation-ready, merge
the PR into main using the repository’s preferred merge strategy.

Close Issue #1 only when its acceptance criteria are genuinely complete.

======================================================================
5. PHASE B: OPEN-SOURCE AND GITHUB REPOSITORY DECISION
======================================================================

Review and update:

docs/07-research/GITHUB_REPOSITORY_REVIEW.md
docs/07-research/OPEN_SOURCE_ADOPTION_REGISTER.md
OPEN_SOURCE_POLICY.md
THIRD_PARTY_NOTICES.md

Verify current versions, maintenance state and licences before adopting any
package.

Do not download or copy all external repositories into this repository.

Use the following handling model:

A. Install approved libraries through pnpm

Likely approved components:

- MrRefactoring/jira.js
  Purpose: Jira Cloud REST, Agile and Jira Service Management client.
  Use it only behind our own narrow Jira connector.

- graphile/worker
  Purpose: scheduled jobs, reminders, escalation, retries and reconciliation.

- vercel/ai
  Purpose: provider-neutral model calls, streaming, structured output and
  bounded tool invocation.

- @microsoft/microsoft-graph-client
  Purpose: Outlook, Teams, SharePoint and OneDrive integration in the relevant
  release.

- pptxgenjs
  Purpose: PowerPoint generation.

- exceljs
  Purpose: spreadsheet generation and structured spreadsheet processing where
  appropriate.

- official OIDC, schema validation, testing and observability libraries that
  have acceptable permissive licences.

B. Reference-only repositories

Inspect only as needed and only for clean-room ideas:

- davidmjackson/sight or Sprintsight
- Morgenruf
- ARAYA
- Ocul-PM
- Intelligent Project Status Agent
- sooperset/mcp-atlassian
- relevant stand-up and status-collection projects

Useful patterns to consider:

- green-versus-evidence contradiction detection;
- cross-project dependency propagation;
- risks discussed informally but absent from RAID;
- claim-versus-evidence comparison;
- contextual update collection;
- per-user timezone handling;
- reminder and escalation state machines;
- approval diffs;
- action receipts;
- shadow mode;
- deterministic versus adaptive execution;
- safe retry and stop behaviour.

Do not copy code, prompts, documentation or thresholds from an unlicensed or
incompatible repository.

C. Do not embed as the product foundation

Do not build the product on or copy code from:

- n8n;
- Plane;
- OpenProject;
- Leantime;
- a full project-management replacement;
- a general-purpose automation platform;
- repositories with no clear commercial licence;
- AGPL, GPL, Sustainable Use, BSL, SSPL or similar dependencies without an
  explicit approved legal decision.

Do not use Git submodules for these projects.

Do not fork a dependency unless:

1. modification of its internals is unavoidable;
2. its licence permits the commercial model;
3. the maintenance burden is justified;
4. an upstream synchronization plan is documented;
5. an ADR approves the fork.

D. Agent framework decision

The current preferred Release 1 approach is:

- deterministic TypeScript application logic;
- PostgreSQL-backed workflow state;
- Graphile Worker;
- Vercel AI SDK for bounded model calls;
- schema-validated output;
- narrow application tools;
- human approval for material actions.

Do not introduce Mastra, LangGraph, Temporal, Kafka, Redis, Kubernetes or a
large multi-agent framework unless the repository review demonstrates a
specific Release 1 requirement that the simpler architecture cannot meet.

Any change to this position requires an ADR containing:

- requirement driving the decision;
- alternatives;
- operational burden;
- licence implications;
- customer-hosting implications;
- migration and replacement path.

======================================================================
6. PHASE C: FINAL IMPLEMENTATION MASTER PLAN
======================================================================

After the corrected baseline is merged, create a new branch:

plan/release-1-master-plan

Create or update:

docs/04-delivery/IMPLEMENTATION_MASTER_PLAN.md
docs/04-delivery/exec-plans/
docs/04-delivery/DEPENDENCY_MAP.md
docs/04-delivery/EPICS_AND_STORIES.md
requirements/traceability/stories.yaml

The master plan must include:

- current repository state;
- approved product scope;
- architecture summary;
- module boundaries;
- implementation sequence;
- dependency graph;
- data migration sequence;
- connector sequence;
- security gates;
- testing gates;
- release gates;
- demo-readiness gates;
- rollback strategy;
- major technical risks;
- major product risks;
- required external credentials;
- mock or synthetic alternatives while credentials are absent;
- clear Definition of Done.

Create GitHub milestones for at least:

R0 – Platform Foundation
R1 – Closed-Loop Delivery Assurance
R2 – Microsoft Enterprise Collaboration
R3 – Portfolio Intelligence

Create implementation issues for R0 and R1.

Every issue must include:

- epic and story ID;
- requirement IDs;
- applicable ADRs;
- scope;
- out of scope;
- acceptance criteria;
- required tests;
- dependencies;
- security impact;
- database impact;
- connector impact;
- Definition of Done.

Do not create hundreds of tiny issues.

Group work into coherent, independently testable product increments that are
large enough to justify Codex execution but small enough for reliable review.

Push the branch, create the PR, validate it and merge it after checks pass.

Do not stop after planning. Continue directly into implementation.

======================================================================
7. APPROVED IMPLEMENTATION ARCHITECTURE
======================================================================

Treat this as the preferred baseline unless the Astra review records and
approves a better decision through an ADR.

Repository style:

- TypeScript-first monorepo;
- pnpm workspaces;
- modular monolith;
- one product repository;
- separate web, API and worker processes from the same codebase.

Frontend:

- React;
- Vite;
- TypeScript;
- Tailwind CSS;
- shadcn/ui or similarly permissively licensed component primitives;
- TanStack Query;
- accessible enterprise UI;
- no paid component-library dependency.

Backend:

- NestJS;
- TypeScript;
- REST and OpenAPI;
- SSE where streaming materially improves the agent experience;
- connector interfaces;
- repository interfaces;
- strict runtime validation;
- structured error handling.

Data:

- PostgreSQL;
- pgvector only where semantic search is genuinely required;
- Prisma behind repository interfaces unless the architecture review approves
  a better low-maintenance choice;
- versioned migrations;
- transactional outbox;
- immutable or append-only action-receipt history;
- structured facts for statuses, dates, budgets, owners and milestones;
- vectors only for unstructured retrieval.

Background work:

- Graphile Worker;
- PostgreSQL-backed state machines;
- idempotent jobs;
- safe retries;
- dead-letter or operational-failure handling;
- no Redis requirement in Release 1.

AI:

- provider-neutral application abstraction;
- Vercel AI SDK;
- Zod or equivalent schema validation;
- customer-provided API key or private endpoint;
- mock AI provider for tests;
- no unrestricted database access;
- no unrestricted Jira access;
- deterministic calculation of project health;
- AI used for interpretation, extraction, explanation, recommendations and
  narrative generation;
- evidence-linked answers;
- prompt-injection handling;
- complete AI invocation audit metadata.

Integrations:

- Jira Cloud first;
- Excel and CSV first;
- Microsoft Graph in the next relevant increment;
- other PM connectors later through the same connector contract.

Reporting:

- authenticated live dashboard;
- concise email summary;
- PptxGenJS for PowerPoint;
- ExcelJS where required;
- HTML-to-PDF for PDF snapshots;
- report period, generation time, data freshness and approval status shown.

Identity and security:

- OIDC-compatible enterprise authentication;
- development-only local authentication;
- application RBAC;
- project- and portfolio-level access;
- least-privilege connector permissions;
- encrypted credentials;
- no credentials in logs or Git;
- human approval for material writes;
- optimistic concurrency check before executing an approved write;
- action receipt after every external write.

Deployment:

- OCI-compatible containers;
- Docker Compose and Podman-compatible deployment;
- customer-hosted single-tenant operation;
- managed PostgreSQL supported;
- bundled PostgreSQL allowed for development;
- backup, restore, upgrade, health check and rollback scripts;
- no mandatory cloud vendor;
- Kubernetes deferred until required.

======================================================================
8. IMPLEMENTATION SEQUENCE
======================================================================

After the review and master-plan PRs are merged, begin implementation.

Use branches and PRs for coherent increments.

Recommended sequence:

Increment 1: Repository and platform foundation

- pnpm workspace;
- applications and packages structure;
- TypeScript configuration;
- React/Vite web application;
- NestJS API;
- worker process;
- PostgreSQL development environment;
- configuration validation;
- health endpoints;
- structured logging;
- local Docker Compose;
- lint, typecheck, test and build scripts;
- CI workflow;
- initial architecture tests;
- production OIDC token/session validation and user/group-to-role mapping;
- server-side project/portfolio authorization and service-policy boundaries;
- encrypted credential storage with key validation and redacted logs;
- denial tests for cross-project access, invalid identity and production demo login;
- shadow mode and outbound action gate, defaulting to no external side effects;
- synthetic-data strategy.

These controls are hard dependencies before real-data ingestion, outbound
notifications or write-back. EPIC-10 verifies and hardens existing controls;
it does not introduce basic authentication or authorization for the first time.

Increment 2: Canonical project model and evidence ledger

- portfolio;
- programme;
- project;
- sprint;
- milestone;
- work item;
- risk;
- issue;
- dependency;
- decision;
- update;
- source record;
- fact;
- evidence;
- fact classification;
- freshness;
- source authority;
- conflict;
- approval;
- action receipt;
- audit event;
- database migrations;
- repository interfaces;
- domain invariants.

Increment 3: Jira and spreadsheet ingestion

- Jira connector wrapper around jira.js;
- test adapter;
- read-only Jira synchronization;
- webhook deduplication;
- scheduled reconciliation;
- OAuth/token abstractions;
- field mapping;
- Excel/CSV import;
- validation preview;
- import errors;
- source-record provenance;
- synthetic Jira fixture environment where live credentials are unavailable.

Increment 4: Freshness, health and contradiction engine

- stale-update rules;
- completeness rules;
- deterministic milestone and blocker signals;
- source conflicts;
- green-versus-evidence contradiction;
- missing owner;
- unconfirmed forecast;
- rule explainability;
- configurable thresholds;
- unit and property-level tests.

Increment 5: Update collection, reminders and escalation

- update request;
- contextual questions;
- secure update link;
- response window;
- timezone handling;
- skip and absence handling;
- reminder sequence;
- PM escalation;
- cancellation after valid response;
- Graphile Worker jobs;
- idempotency;
- audit history.

Increment 6: AI reply interpretation and controlled write-back

- provider abstraction;
- mock provider;
- reply-to-structured-update extraction;
- ambiguity detection;
- clarification;
- confidence and provenance;
- approval diff;
- PM confirmation;
- approved Jira comment write-back; selected-field writes are deferred to R2;
- optimistic concurrency;
- unknown outcome handling;
- action receipts;
- complete audit trail.

Increment 7: Role workspaces and leadership Q&A

- PM action queue;
- Scrum Master signals;
- team-lead signals;
- PMO portfolio queue;
- leadership view;
- evidence-backed “Why is this project delayed?” answer;
- change-since-last-update;
- pending decision queries;
- stale or conflicting-data disclosure;
- project-level authorisation tests.

Increment 8: Reporting, demo flow and production hardening

- live dashboard;
- management email preview;
- PowerPoint generation;
- PDF snapshot;
- source freshness and approval indicators;
- event demonstration dataset;
- shadow mode;
- backup and restore;
- deployment documentation;
- failure recovery;
- threat-model verification;
- golden AI evaluations;
- browser testing;
- release evidence.

You may revise this sequence when the Astra review finds a better dependency
order. Record the reason.

======================================================================
9. GIT AND GITHUB OPERATING RULES
======================================================================

Do not perform routine implementation directly on main.

For every coherent increment:

1. Update main.
2. Create a focused branch.
3. Create or update the ExecPlan when required by PLANS.md.
4. Implement the complete vertical increment.
5. Add meaningful tests.
6. Run required local validation.
7. Inspect the complete diff.
8. Commit in logical groups.
9. Push the branch.
10. Open a pull request.
11. Link requirements, stories and issues.
12. Include validation evidence.
13. Have a separate non-author reviewer agent review the exact candidate SHA.
14. Fix justified issues.
15. Wait for required GitHub Actions.
16. Merge only when checks pass.
17. Delete the merged feature branch when appropriate.
18. Update issues, traceability and implementation status.

Use `gh` for GitHub operations when authenticated.

Do not force-push main.

Do not rewrite shared history unnecessarily.

Do not bypass a failing required check.

Do not claim a PR is complete until the remote checks are actually green.

======================================================================
10. TESTING AND VERIFICATION
======================================================================

Run tests appropriate to the change and complete required checks.

Do not create superficial tests that simply duplicate implementation details.

Use meaningful verification for:

- domain rules;
- database migrations;
- source authority;
- freshness calculations;
- reminder cancellation;
- escalation;
- connector error handling;
- duplicate events;
- token refresh;
- optimistic concurrency;
- ambiguous AI output;
- unsupported claims;
- prompt injection;
- project-level authorisation;
- write approval;
- unknown external write outcome;
- action receipts;
- backup and restore;
- browser workflows.

Required commands should eventually include:

pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:e2e

Add commands gradually as the relevant test layers exist.

Use Playwright for critical browser workflows.

Use contract tests around Jira and other connectors.

Use deterministic fixtures and mock providers in CI.

Live external integration tests must be opt-in and must not require production
credentials.

Once appropriate tests pass, repeat or broaden testing only when new changes,
failures or unresolved risks justify it.

======================================================================
11. SECURITY AND AGENT SAFETY
======================================================================

The language model must not:

- query arbitrary database tables;
- execute arbitrary SQL;
- receive raw administrator credentials;
- call unrestricted Jira APIs;
- send arbitrary email;
- modify arbitrary source-system fields;
- decide its own permissions;
- silently override source conflicts;
- invent a delay cause;
- rank employee performance;
- blame an individual without verified evidence;
- alter project baselines, budgets or customer commitments without approval.

Expose narrow tools such as:

get_authorised_project
get_verified_project_facts
get_open_blockers
get_project_dependencies
get_fact_evidence
get_update_freshness
propose_project_update
request_clarification
create_approval_request
execute_approved_jira_change

Every leadership answer must:

- apply user and project permissions before retrieval;
- use the latest authorised facts;
- cite or link supporting evidence;
- identify stale or conflicting sources;
- clearly label inference and uncertainty;
- refuse to manufacture an explanation when evidence is insufficient.

Every material external action must:

- have a proposal;
- show current and proposed values;
- identify the supporting source;
- identify the approver;
- check that the source record has not changed;
- execute idempotently where possible;
- record success, failure or unknown outcome;
- produce an action receipt.

======================================================================
12. WORKING STYLE
======================================================================

Take ownership of the project.

Do not stop after producing a review report.

Do not stop after producing a plan.

After the documentation and master-plan gates pass, immediately start the first
implementation increment.

Use subagents for substantial parallel work, not for trivial tasks.

Prefer larger coherent tasks over many tiny tasks.

Keep architecture simple unless requirements justify added complexity.

Use one common platform and configuration model. Do not create customer-specific
branches.

Keep customer-specific differences in:

- field mappings;
- terminology;
- source-authority rules;
- RAG rules;
- reminder cadence;
- escalation matrix;
- approval matrix;
- report templates;
- branding;
- enabled connectors;
- AI provider configuration;
- feature flags.

Maintain an implementation progress report in the repository, for example:

docs/04-delivery/IMPLEMENTATION_STATUS.md

Update it after each merged increment with:

- completed stories;
- implemented requirement IDs;
- percentage by release: merged completed stories divided by the fixed approved story count, with numerator and denominator;
- tests and evidence;
- current risks;
- blockers;
- next coherent increment.

Do not inflate completion percentages.

======================================================================
13. COMPLETION REPORT FOR THIS CODEX RUN
======================================================================

At the end of the current run, provide a concise but complete report containing:

1. Repository state found.
2. Subagents used and their assignments.
3. Documentation findings.
4. P0 and P1 findings resolved.
5. Architecture or scope changes made.
6. Open-source decisions made.
7. Files changed.
8. Branches created.
9. Commits created.
10. GitHub issues created or updated.
11. Pull requests created.
12. Pull requests merged.
13. GitHub Actions results.
14. Implementation completed.
15. Tests run and exact outcomes.
16. Current realistic R0 and R1 completion percentages.
17. Remaining blockers.
18. The exact next coherent task.

Do not report something as pushed, reviewed, tested, merged or green unless you
have verified it from Git and GitHub.

Begin now by inspecting the repository and Issue #1.