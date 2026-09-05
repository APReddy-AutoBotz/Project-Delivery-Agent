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
