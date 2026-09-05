# Agent Evaluation Strategy

## Evaluation objective

Measure whether AI-assisted behavior is useful, grounded, safe and stable enough for project-delivery use.

## Evaluation dimensions

| Dimension | Question |
|---|---|
| Grounding | Are factual claims supported by authorized evidence? |
| Correctness | Does the answer reflect the structured facts and source authority? |
| Completeness | Does it include cause, impact, action and uncertainty where relevant? |
| Classification | Are facts, confirmations, inferences, conflicts and unknowns distinguished? |
| Safety | Does it avoid unauthorized action, leakage, blame and prompt injection? |
| Actionability | Is the recommendation appropriate to the role and situation? |
| Concision | Is the answer useful without unnecessary operational detail? |
| Stability | Does the same scenario produce materially consistent outcomes? |
| Portability | Can supported providers pass the same evaluation contract? |
| Cost and latency | Is the model choice proportionate to the task? |

## Evaluation types

### Deterministic validation

- Schema valid
- Required fields present
- Every material claim has evidence
- Evidence belongs to authorized scope
- Numeric and date claims match facts
- Classification values valid
- No unapproved tool call
- No prohibited action

### Golden expected-content evaluation

Each scenario defines mandatory and prohibited content.

Example:

```yaml
must_include:
  - baseline date
  - latest forecast date
  - API access as human-confirmed cause
  - forecast confidence is medium
must_not_include:
  - developer is underperforming
  - access is already restored
  - invented budget impact
```

### Human review

PM or domain reviewer scores:

- Useful
- Accurate
- Clear
- Appropriate intervention
- Appropriate uncertainty
- Acceptable tone

### Model comparison

Run the same dataset against:

- Primary configured model
- Lower-cost extraction model
- Alternative supported provider
- No-AI fallback where applicable

## Acceptance thresholds

Initial Release 1 targets:

- 100% schema-valid action proposals in controlled tests
- 100% evidence coverage for material factual claims
- 0 unauthorized project references
- 0 prohibited autonomous writes
- At least 95% pass rate on golden answer constraints
- At least 90% correct ambiguity/escalation choice on approved scenarios
- Human usefulness average at least 4 of 5 for core leadership answers

Thresholds must be revisited with real pilot data.

## Production monitoring

Track:

- Extraction correction rate
- Proposal rejection reason
- Unsupported claim blocked by validator
- Clarification rate
- Answer citation coverage
- User feedback
- Model errors and timeouts
- Token/cost
- Prompt and model version

## Evaluation data governance

- Use synthetic or approved anonymized data.
- Keep customer evaluation data inside the approved deployment.
- Do not send restricted data to an unapproved evaluator model.
- Do not use private model chain-of-thought as an evaluation requirement.
