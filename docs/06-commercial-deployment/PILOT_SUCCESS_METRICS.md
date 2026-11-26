# Pilot Success Metrics

## Baseline collection

Before activation, measure at least one normal reporting cycle where practical.

## Core measures

| Metric | Baseline | Target direction |
|---|---:|---|
| PM/PMO hours per reporting cycle | Customer measured | Reduce |
| Projects updated by deadline | Customer measured | Increase |
| Median age of latest project update | Customer measured | Reduce |
| Manual reminders sent | Customer measured | Reduce |
| Time to prepare leadership report | Customer measured | Reduce |
| Time to answer ad hoc status question | Customer measured | Reduce |
| Material claims with evidence | Customer measured | Increase |
| Risks identified before steering meeting | Customer measured | Increase appropriately |
| Extracted responses accepted without change | New | Increase |
| False or low-value alerts | New | Keep within agreed tolerance |

## Suggested pilot success threshold

A pilot may be considered commercially successful when:

- At least 80% of selected project updates are received on time, or there is a material improvement from baseline.
- Reporting-cycle effort reduces by at least 30%, or equivalent quantified value is demonstrated.
- 100% of material leadership claims in the pilot view have evidence or explicit uncertainty.
- 100% of external writes have the required approval and receipt.
- PM usefulness score averages at least 4 of 5.
- Leadership usefulness score averages at least 4 of 5.
- No critical security or access-control issue occurs.
- Customer agrees to production next steps or a defined paid extension.

Targets must be agreed per customer and should not be represented as guaranteed outcomes before validation.

## Qualitative questions

- Did the agent ask the right person?
- Was the question specific enough?
- Did reminders feel appropriate?
- Was the recommendation useful?
- Did the approval diff make the action clear?
- Did leadership trust the evidence?
- Which steps still required manual PMO work?
- Which configuration was difficult?

## Measurement evidence

Before a pilot, the customer PMO owner records the agreed observation windows,
included projects, exclusions, metric denominators and baseline collection method.
Compare chasing/reporting effort, fresh required updates and risk-detection timing
over the agreed windows. Validate aggregate calculations with synthetic fixtures;
do not claim commercial improvement until observed pilot results support it. Do
not rank employees from response time or activity counts.

### Calculate the aggregate pilot measures

Use the [synthetic example](../../tests/fixtures/pilot-measurement.json) to see
the input format and run the calculator from the repository root.

```sh
node scripts/measure-pilot.mjs tests/fixtures/pilot-measurement.json
```

For a customer pilot, keep a copy in the customer's approved environment.
The PMO owner records the agreed cohort, exclusions and collection method
before collecting data. Use the same definitions in both windows and
document any change before interpreting results. Enter UTC timestamps and
treat each window as inclusive of its start and exclusive of its end.
Populate only aggregate counts, total effort and the two timestamps per
included material risk. Leave project, employee and source-record identifiers
out of observations.

| Measure | Numerator or observations | Denominator |
| --- | --- | --- |
| Chasing and reporting effort | Total minutes, split between chasing and report preparation | Completed reporting cycles in the window |
| Completed updates | Due updates received by the end of the window | All updates due in the window |
| On-time updates | Due updates received by their agreed deadline | All updates due in the window |
| Projects with a current verified update | Active projects with a verified update meeting freshness policy at the agreed period-end cutoff | Included active projects at that cutoff |
| Risk detection lead time | Minutes from first detection in the window to the scheduled report, one observation per included material risk | Included material risks with both timestamps |

The output gives the counts behind each ratio and the median risk lead time.
A positive lead means detection preceded the report, and a negative lead
means detection followed it. A zero denominator produces an unavailable
value. The calculator retains the input's synthetic or observed label and
leaves the commercial conclusion to the PMO owner. The
[PILOT-001 fixture checks](../../tests/pilot-measurement.test.ts) exercise the
calculation, missing observations and invalid input. Customer agreement and
observed pilot results are still required for pilot outcome evidence.
