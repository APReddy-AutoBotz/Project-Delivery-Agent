# Change Control

## Change classes

| Class | Example | Approval |
|---|---|---|
| Editorial | Grammar or formatting with no change in meaning | Document owner |
| Clarification | Makes an approved requirement more precise without changing scope | Product Owner |
| Functional | Adds, removes or changes product behaviour | Product Owner and architecture review |
| Security or autonomy | Changes permissions, AI access or write authority | Product Owner and security review |
| Architectural | Changes major technology, boundaries or deployment | Approved ADR |
| Commercial | Changes customer rights, licensing or support obligation | Product Owner and legal/commercial review |

## Required change information

Every non-editorial change must identify:

- Change reason
- Affected requirement IDs
- Affected documents
- Release impact
- Security and privacy impact
- Data migration impact
- Test impact
- Backward-compatibility impact
- Customer-deployment impact
- Decision owner

## Baseline rule

Implementation must not silently redefine the product. When code reveals a missing or contradictory requirement:

1. Open a documentation change.
2. Update the requirement and acceptance criteria.
3. Review architecture and security effects.
4. Approve the change.
5. Resume implementation.

## Emergency fixes

A security or production recovery fix may precede documentation only when delay would create greater risk. The related documents and requirements must be updated in the same release cycle, and the exception must be recorded in the pull request.
