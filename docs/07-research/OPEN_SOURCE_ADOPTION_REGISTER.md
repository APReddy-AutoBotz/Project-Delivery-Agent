# Open-Source Adoption Register

**Review date:** 2026-09-05

Every runtime dependency must be pinned through the lockfile and reviewed before release.

| Component | Purpose | Licence | Decision | Integration method | Notes |
|---|---|---|---|---|---|
| React | Web UI | MIT | Proposed | Use published package | Web framework; replacement would be costly |
| Vite | Web build | MIT | Proposed | Use published package | Standard static web build |
| Tailwind CSS | Styling | MIT | Proposed | Use published package | Avoid commercial Tailwind Plus assets unless licensed |
| shadcn/ui | Component source patterns | MIT | Proposed | Copy only generated components with notices as applicable | Review component provenance |
| NestJS | API framework | MIT | Proposed | Use published package | Keep domain independent |
| PostgreSQL | Database | PostgreSQL Licence | Approved | Customer or bundled service | Core operational dependency |
| pgvector | Vector extension | PostgreSQL-style | Proposed | Database extension | Optional semantic retrieval |
| Prisma | ORM/migrations | Apache-2.0 | Proposed | Use published package | Wrap behind repositories |
| Graphile Worker | Background jobs | MIT | Approved in baseline | Use published package | Replacement: custom queue or Temporal |
| Vercel AI SDK | AI provider abstraction | Apache-2.0 | Approved in baseline | Use published package | Wrap behind first-party interface |
| jira.js | Jira SDK | MIT | Approved in baseline | Use published package | Wrap behind connector |
| Microsoft Graph JS SDK | Microsoft 365 SDK | MIT | R2 proposed | Use published package | Wrap behind connector |
| PptxGenJS | PowerPoint generation | MIT | Approved in baseline | Use published package | Template logic remains proprietary |
| ExcelJS | Spreadsheet generation | MIT | Proposed | Use published package | Spreadsheet import may use separate parser |
| Playwright | Browser testing/PDF rendering | Apache-2.0 | Proposed | Use published package | Keep browser images patched |
| MCP TypeScript SDK | Future MCP interface | Apache/MIT transition | Evaluate R5 | Use published package after licence review | No direct DB/connector bypass |
| Microsoft MarkItDown | Document extraction sidecar | MIT | Optional | Install as isolated Python package | Not in R1 |
| Langfuse | AI observability | MIT core, enterprise areas separate | Defer | Optional customer/self-hosted service | Use internal audit first |
| LangGraph JS | Agent graph | MIT | Defer | Add only through ADR | Not needed for explicit R1 flow |
| Mastra | Agent/workflow framework | Apache core, enterprise areas separate | Defer | Add only through ADR/legal review | Avoid R1 platform dependency |

## Runtime dependency entry template

```text
Package:
Version:
Repository:
Licence:
Purpose:
Runtime or development only:
Modified:
Notices:
Security owner:
Replacement path:
Approved by:
Review date:
```

## Prohibited without explicit approval

- GPL, AGPL, SSPL or Sustainable Use runtime code
- Repositories without a licence
- Enterprise-only directories from mixed-license projects
- Vendored copies of complete external repositories
- Git submodules used to bypass normal dependency review
## Foundation package adoption

Go 1.26.8 (BSD-3-Clause) is approved for the foundation Caddy build under the
delegated permissive-license policy on 2026-09-07. It replaces the embedded Go
runtime while retaining Caddy 2.11.4 (Apache-2.0), its published module graph and
standard HTTPS interface. Upstream source is downloaded in the build stage and
is not vendored into this repository. The controller owns updates and security
review; the replacement path is another reviewed Caddy/toolchain build behind the
same HTTPS interface. Original Go/Caddy notices are retained and hash-checked.
Exact build-image pins, sources, runtime paths and unresolved distribution review
are in [FOUNDATION_IMAGE_REGISTER.md](FOUNDATION_IMAGE_REGISTER.md).

Development-only image evidence tooling is recorded in
[DISTRIBUTION_TOOL_REGISTER.md](DISTRIBUTION_TOOL_REGISTER.md). Syft 1.51.1 and
Grype 0.118.0 are checksum-pinned Apache-2.0 publisher executables; neither is a
runtime dependency or a shipped customer component.

Exact direct dependencies verified against publisher metadata on 2026-09-06. Runtime entries are approved for local foundation implementation under the delegated permissive-license policy. Full transitive notices, image inventory and vulnerability disposition remain release gates. No upstream source was copied or modified. The machine-readable record [DEPENDENCIES.json](DEPENDENCIES.json) includes consumers, owners and replacement paths.

| Published package | Version | License | Use |
|---|---|---|---|
| [@eslint/js](https://registry.npmjs.org/%40eslint%2Fjs/10.0.1) | 10.0.1 | MIT | Development |
| [@nestjs/common](https://registry.npmjs.org/%40nestjs%2Fcommon/11.2.3) | 11.2.3 | MIT | Runtime |
| [@nestjs/core](https://registry.npmjs.org/%40nestjs%2Fcore/11.2.3) | 11.2.3 | MIT | Runtime |
| [@nestjs/platform-express](https://registry.npmjs.org/%40nestjs%2Fplatform-express/11.2.3) | 11.2.3 | MIT | Runtime |
| [@nestjs/swagger](https://registry.npmjs.org/%40nestjs%2Fswagger/11.4.7) | 11.4.7 | MIT | Runtime |
| [@playwright/test](https://registry.npmjs.org/%40playwright%2Ftest/1.63.0) | 1.63.0 | Apache-2.0 | Development |
| [@prisma/adapter-pg](https://registry.npmjs.org/%40prisma%2Fadapter-pg/7.10.0) | 7.10.0 | Apache-2.0 | Runtime |
| [@prisma/client](https://registry.npmjs.org/%40prisma%2Fclient/7.10.0) | 7.10.0 | Apache-2.0 | Runtime |
| [@tailwindcss/vite](https://registry.npmjs.org/%40tailwindcss%2Fvite/4.3.3) | 4.3.3 | MIT | Development |
| [@tanstack/react-query](https://registry.npmjs.org/%40tanstack%2Freact-query/5.102.8) | 5.102.8 | MIT | Runtime |
| [@types/node](https://registry.npmjs.org/%40types%2Fnode/24.0.0) | 24.0.0 | MIT | Development |
| [@types/pg](https://registry.npmjs.org/%40types%2Fpg/8.23.1) | 8.23.1 | MIT | Development |
| [@types/react](https://registry.npmjs.org/%40types%2Freact/19.2.18) | 19.2.18 | MIT | Development |
| [@types/react-dom](https://registry.npmjs.org/%40types%2Freact-dom/19.2.7) | 19.2.7 | MIT | Development |
| [@vitejs/plugin-react](https://registry.npmjs.org/%40vitejs%2Fplugin-react/5.2.0) | 5.2.0 | MIT | Development |
| [ajv](https://registry.npmjs.org/ajv/8.20.0) | 8.20.0 | MIT | Development |
| [ajv-formats](https://registry.npmjs.org/ajv-formats/3.0.1) | 3.0.1 | MIT | Development |
| [deepmerge-ts](https://registry.npmjs.org/deepmerge-ts/8.0.0) | 8.0.0 | BSD-3-Clause | Development |
| [eslint](https://registry.npmjs.org/eslint/10.10.0) | 10.10.0 | MIT | Development |
| [graphile-worker](https://registry.npmjs.org/graphile-worker/0.17.3) | 0.17.3 | MIT | Runtime |
| [jose](https://registry.npmjs.org/jose/6.2.12) | 6.2.12 | MIT | Runtime |
| [js-yaml](https://registry.npmjs.org/js-yaml/5.3.0) | 5.3.0 | MIT | Development |
| [mysql2](https://registry.npmjs.org/mysql2/3.23.1) | 3.23.1 | MIT | Development |
| [oidc-client-ts](https://registry.npmjs.org/oidc-client-ts/3.5.0) | 3.5.0 | Apache-2.0 | Runtime |
| [pg](https://registry.npmjs.org/pg/8.23.0) | 8.23.0 | MIT | Runtime |
| [prettier](https://registry.npmjs.org/prettier/3.6.2) | 3.6.2 | MIT | Development |
| [prisma](https://registry.npmjs.org/prisma/7.10.0) | 7.10.0 | Apache-2.0 | Development |
| [react](https://registry.npmjs.org/react/19.2.8) | 19.2.8 | MIT | Runtime |
| [react-dom](https://registry.npmjs.org/react-dom/19.2.8) | 19.2.8 | MIT | Runtime |
| [reflect-metadata](https://registry.npmjs.org/reflect-metadata/0.2.2) | 0.2.2 | Apache-2.0 | Runtime |
| [rxjs](https://registry.npmjs.org/rxjs/7.8.2) | 7.8.2 | Apache-2.0 | Runtime |
| [tailwindcss](https://registry.npmjs.org/tailwindcss/4.3.3) | 4.3.3 | MIT | Development |
| [typescript](https://registry.npmjs.org/typescript/5.9.3) | 5.9.3 | Apache-2.0 | Development |
| [typescript-eslint](https://registry.npmjs.org/typescript-eslint/8.69.0) | 8.69.0 | MIT | Development |
| [vite](https://registry.npmjs.org/vite/7.3.6) | 7.3.6 | MIT | Development |
| [vitest](https://registry.npmjs.org/vitest/4.1.11) | 4.1.11 | MIT | Development |
| [zod](https://registry.npmjs.org/zod/4.5.4) | 4.5.4 | MIT | Runtime |

## Web transfer-tool exclusion, 2026-09-08

The next web packaging increment removes the existing unused curl/libcurl
dependency closure; it adds no runtime package or license adoption. The exact
removed set and retained shared components are recorded in
[FOUNDATION_IMAGE_REGISTER.md](FOUNDATION_IMAGE_REGISTER.md). Require matching
runtime and all-layer evidence before acceptance. Remaining OS/transitive license
and original-notice review obligations remain open.

## Compiled Go attribution inventory, 2026-09-08

The machine-readable [Caddy module inventory](../../scripts/distribution/caddy-modules.json)
registers each of the existing 144 non-stdlib modules (Caddy plus 143 dependencies)
with its exact version, compiled h1 and original attribution paths/sizes/hashes.
All entries are **review-required**, not new dependency or license approvals.
Consumer: the foundation HTTPS gateway. Owner: implementation controller for
maintenance and security, with legal/product review before commercial distribution.
Replacement path: a reviewed Caddy/module/toolchain build behind the same HTTPS
interface; any module or notice pin change requires independent review.

The 197 original files form a source-module superset. For example, the existing
zeebo/blake3 source includes CC0, quic-go's assets notice has logo/trademark terms,
and nebula's Windows Wintun subtree has a separate prebuilt-DLL agreement. Their
presence in source archives does not establish that the associated platform/asset
code is in the Linux binary. Applicability and license choice remain explicit
review work; no new source code or DLL is copied into the product by collection.
Generated data, source headers, complete Go standard-library attribution and all
other OS/npm/native components require their own review.

Source authenticity and collection limits are recorded in ADR-014 and
DISTRIBUTION_EVIDENCE_VALIDATION.md. The helper reuses the pinned Go compiler and
standard library only; it adds no dependency, service or runtime executable.

## Existing npm notice attribution, 2026-09-08

The [npm notice policy](../../scripts/distribution/npm-notices.json) records four
existing locked packages; it is an attribution evidence baseline, not new adoption
or final license approval. Original publisher tarball integrity was matched to
the exact lockfile, and selected file bytes were compared with immutable image
digests before implementation. Collection preserves those originals without
network enrichment or changes to installed package files.

| Existing package | Original notice | Consumers | Publisher source |
|---|---|---|---|
| @tokenizer/token 0.3.0 | README.md containing original MIT notice | API | [version metadata](https://registry.npmjs.org/%40tokenizer%2Ftoken/0.3.0) |
| pg-types 2.2.0 | README.md containing original MIT notice | API, worker, operations | [version metadata](https://registry.npmjs.org/pg-types/2.2.0) |
| pgpass 1.0.5 | README.md containing original MIT notice | API, worker, operations | [version metadata](https://registry.npmjs.org/pgpass/1.0.5) |
| rxjs 7.8.2 | LICENSE.txt, Apache-2.0 publisher notice | API, including five embedded entrypoints | [version metadata](https://registry.npmjs.org/rxjs/7.8.2) |

Owner: implementation controller for maintenance and source-evidence updates;
legal/product review remains required for commercial distribution. Replace or
upgrade these packages only through their existing consumer boundaries and a
reviewed lock/policy update. No package upgrade or licence choice is made here.
The policy separately pins root/entrypoint manifest hashes, target coverage and
original notice hashes. README capture and explicit RxJS parent attribution close
the twelve identified evidence gaps only; complete npm/source-header/OS/native
attribution and the remaining security/signing gates stay open.

## Existing Node binary/component source coverage, 2026-09-08

The [Node policy](../../scripts/distribution/node-components.json) records the
existing Node 24.19.0 binary, exact process metadata, eleven reviewed original
source-file hashes and the complete original notice partition. The source commit
is `cdc1b38d40cb567b7ad0b39c86addf830a0af0ae`; publisher source URLs are retained
with each file. This is source/metadata attribution for an existing dependency,
not new package adoption or a license choice.

The 29 metadata keys comprise the runtime, 21 versioned libraries, two ABI/API
values, three ICU-related data values and two empty disabled QUIC values. Eighteen
versioned libraries and the two disabled keys map to original source sections;
nbytes, ncrypto and sqlite have no literal section in the root notice and remain
unresolved. ABI/data keys are not application packages. Built-in undici, for
example, must not borrow the identity or notice of an application npm dependency.

The notice retains all 44 top-level source sections, including 24 without their
own version keys. They include source tools/tests, removed package-manager
material and in-tree libraries; source presence or an absent version key does not
settle shipped membership. Full source/header/platform/data applicability and
component notices remain explicit review work. Runtime metadata and reviewed
source hashes do not establish a reproducible source-to-binary build.

Consumers: API, worker and operations. Owner: implementation controller for
maintenance/source evidence; legal/product approval remains required before
commercial distribution. Replacement path: a separately reviewed Node/base-image
update through existing runtime boundaries with fresh binary/metadata/notice pins
and complete immutable acceptance. No source archive or new library is copied
into customer images by this evidence increment.

## Node supplemental source notices, 2026-09-08

No dependency is added or upgraded. The [supplemental policy](../../scripts/distribution/node-supplemental.json)
pins four original files at the same Node source commit and 150 notice outputs for
the existing API, worker and operations binary. Full original sources are
authenticated in a build stage; final images contain only notice bytes and index.

| Existing component | Original source observation | Packaged evidence | Remaining review |
|---|---|---|---|
| nbytes 0.1.4 | Original `deps/nbytes/LICENSE` headed MIT License, crediting Node.js | Complete original 1,064-byte file | Component/source applicability and full distribution review |
| SQLite 3.53.3 | Original copyright-disclaimer/blessing and public-domain language in amalgamation/header comments | 149 complete original comment extracts, 144,879 bytes, retaining separate occurrences | Conditional/platform/header and actual linked composition |
| ncrypto 0.0.1 | No component-specific notice in its seven-file subtree; README describes Node-internal extraction, with an OpenSSL formatting reference in source | Explicit unresolved supplemental status; no borrowed notice | Determine original attribution and applicability |

The policy records exact publisher URLs, full parent-source sizes/SHA-256, output
ranges and hashes. Original text is not rewritten into a synthetic licence.
Embedded examples remain inside original comment wrappers. Independent source
checks establish byte correspondence, not legal acceptance, signed execution or
a reproducible build. Existing root-notice gaps remain separately recorded.

Owner: implementation controller for source maintenance and implementation;
legal/product review remains required for distribution. Replacement/recovery is
a reviewed Node/source-policy update or packaging revert with fresh immutable
acceptance. No licence choice, dependency version or connector-scope change occurs.
