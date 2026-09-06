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
