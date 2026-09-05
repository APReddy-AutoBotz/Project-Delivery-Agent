# GitHub Repository Review

**Review date:** 2026-09-05

## Conclusion

No reviewed public repository provides a mature, permissively licensed, production-ready implementation of the complete intended product.

The correct approach is:

- Build the proprietary domain, evidence, policy, approval and Q&A core.
- Adopt focused libraries through package managers.
- Inspect reference projects for general ideas.
- Do not combine or vendor complete repositories.

## Runtime candidates

| Repository | Purpose | Licence | Decision |
|---|---|---|---|
| https://github.com/MrRefactoring/jira.js | TypeScript Jira REST client | MIT | Adopt behind connector wrapper |
| https://github.com/graphile/worker | PostgreSQL-backed job queue | MIT | Adopt |
| https://github.com/vercel/ai | TypeScript AI SDK | Apache-2.0 | Adopt behind provider interface |
| https://github.com/microsoftgraph/msgraph-sdk-javascript | Microsoft Graph client | MIT | Adopt in R2 |
| https://github.com/gitbrent/PptxGenJS | PowerPoint generation | MIT | Adopt |
| https://github.com/modelcontextprotocol/typescript-sdk | MCP server/client SDK | Apache/MIT transition | Evaluate for R5 |
| https://github.com/microsoft/markitdown | Office/document extraction | MIT | Optional isolated sidecar |

## Connector references

### sooperset/mcp-atlassian

Repository: https://github.com/sooperset/mcp-atlassian

Useful for:

- Jira and Confluence tool design
- Cloud and Data Center authentication patterns
- MCP naming
- Error handling

Decision:

- Reference only initially
- Python runtime is not aligned with the TypeScript-first core
- Do not expose broad write tools directly to the product agent

### Atlassian official MCP server

Repository: https://github.com/atlassian/atlassian-mcp-server

Useful for:

- Understanding official Atlassian MCP direction
- Future compatibility
- Competitive benchmarking

Decision:

- Do not use as the customer-hosted core
- Consider future integration or interaction layer

## Product-thinking references

### Sprintsight

Repository: https://github.com/davidmjackson/sight

Useful concepts:

- Cross-team dependency propagation
- Reported-green versus objective-risk detection
- Risk discussed informally but missing from RAID
- Evidence-backed status

Limitations:

- Early specification/foundation stage at review date
- No clear repository licence found in the initial review
- Do not copy code or documentation

Decision: Clean-room ideas only.

### Intelligent Project Status Agent

Repository: https://github.com/sonaljoshi-ui/Intelligent-Project-Status-Agent

Useful concepts:

- Search, investigate, evaluate, compare and decide
- Human escalation
- Safe failure
- Fact versus analysis separation

Limitations:

- Primarily instructions and samples
- No clear licence found in the initial review

Decision: Clean-room ideas only.

### Ocul-PM

Repository: https://github.com/bunhine0452/Ocul-PM

Useful concepts:

- Claim versus evidence comparison
- Action receipts
- Approval visibility
- Local-first design

Decision: Reference patterns; no product dependency.

### ARAYA

Repository: https://github.com/mahg-es/araya

Useful concepts:

- Explicit role permissions
- Safe/dry-run mode
- Traceability
- Deterministic versus adaptive policy
- Independent verification

Decision: Reference patterns; do not create a large agent swarm.

### Morgenruf

Repository: https://github.com/morgenruf/morgenruf

Useful concepts:

- Time-zone-aware schedules
- Direct update collection
- Custom questions
- Skip and absence
- Edit window
- Participation analytics
- Signed webhooks

Decision: Reference interaction patterns; implement in TypeScript.

## Agent-framework candidates

| Repository | Strength | Decision |
|---|---|---|
| https://github.com/openai/openai-agents-js | Tools, guardrails, sessions, human-in-loop | Evaluate only if provider strategy fits |
| https://github.com/langchain-ai/langgraphjs | Durable stateful agent graphs | Defer until proven complexity |
| https://github.com/mastra-ai/mastra | TypeScript agents, workflows, memory, evals | Defer; avoid platform dependency in R1 |
| https://github.com/vercel/ai | Thin provider-neutral primitives | Preferred R1 |

Release 1 uses explicit application workflows plus bounded AI calls. It does not require a multi-agent framework.

## Repositories not suitable as product foundation

| Repository | Reason |
|---|---|
| https://github.com/n8n-io/n8n | Sustainable Use licence and commercial redistribution concerns |
| https://github.com/makeplane/plane | Full PM product and AGPL |
| https://github.com/opf/openproject | Full PM product and GPL |
| https://github.com/Leantime/leantime | Full PM product and AGPL |
| https://github.com/activepieces/activepieces | Large general platform; mixed core/enterprise boundaries; unnecessary footprint |

## Clean-room rule

For any incompatible or unlicensed reference:

1. Record an abstract internal requirement.
2. Stop consulting the reference.
3. Implement independently using our requirements, architecture and official API documentation.
4. Test against our own synthetic scenarios.
