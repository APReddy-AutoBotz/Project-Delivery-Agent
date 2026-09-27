import { describe, expect, it } from "vitest";
import {
  evaluateBlockerAgeSignals,
  type BlockerAgeSignalInput,
} from "../packages/domain/src/index.js";

const blocker = (
  overrides: Partial<BlockerAgeSignalInput["blockers"][number]> = {},
): BlockerAgeSignalInput["blockers"][number] => ({
  targetType: "RAID_ITEM",
  targetKey: "ISSUE-1",
  state: "OPEN",
  sourceDate: "2026-03-07",
  sourceDateField: "openedAt",
  source: {
    kind: "external_record",
    sourceSystem: "jira",
    instanceKey: "acme",
    externalType: "issue",
    externalId: "PDA-17",
    externalRevision: "7",
  },
  ...overrides,
});
const request = (
  overrides: Partial<BlockerAgeSignalInput> = {},
): BlockerAgeSignalInput => ({
  asOf: "2026-03-10T12:00:00.000Z",
  timeZone: "UTC",
  blockerReadComplete: true,
  threshold: {
    ruleKey: "blocker-age",
    ruleRevision: "blocker-age-v1",
    minimumBlockerAgeDays: 3,
  },
  blockers: [blocker()],
  ...overrides,
});

describe("UNIT-HLT-003: deterministic blocker age signals", () => {
  it("calculates calendar age from the source date and exposes the applied threshold", () => {
    const result = evaluateBlockerAgeSignals(request());
    expect(result).toMatchObject({
      asOf: "2026-03-10T12:00:00.000Z",
      timeZone: "UTC",
      localDate: "2026-03-10",
      threshold: {
        ruleKey: "blocker-age",
        ruleRevision: "blocker-age-v1",
        minimumBlockerAgeDays: 3,
      },
      assessments: [
        {
          targetType: "RAID_ITEM",
          targetKey: "ISSUE-1",
          state: "OPEN",
          sourceDate: "2026-03-07",
          sourceDateField: "openedAt",
          ageDays: 3,
          thresholdExceeded: true,
          status: "AGED",
          threshold: {
            ruleRevision: "blocker-age-v1",
            minimumBlockerAgeDays: 3,
          },
        },
      ],
    });
  });

  it("uses local calendar days across a daylight-saving boundary", () => {
    const result = evaluateBlockerAgeSignals(
      request({
        asOf: "2026-03-09T04:30:00.000Z",
        timeZone: "America/New_York",
        blockers: [blocker({ sourceDate: "2026-03-08" })],
      }),
    );
    expect(result.localDate).toBe("2026-03-09");
    expect(result.assessments[0]).toMatchObject({
      ageDays: 1,
      thresholdExceeded: false,
      status: "WITHIN_THRESHOLD",
      sourceDate: "2026-03-08",
    });
  });

  it("leaves missing source dates unassessable and excludes closed blockers", () => {
    const result = evaluateBlockerAgeSignals(
      request({
        blockers: [
          blocker({
            targetKey: "ISSUE-MISSING-DATE",
            sourceDate: null,
            sourceDateField: null,
          }),
          blocker({
            targetKey: "ISSUE-CLOSED",
            state: "COMPLETE",
          }),
          blocker({
            targetKey: "ISSUE-YOUNG",
            sourceDate: "2026-03-09",
            sourceDateField: "created",
          }),
        ],
      }),
    );
    expect(result.assessments).toMatchObject([
      {
        targetKey: "ISSUE-MISSING-DATE",
        ageDays: null,
        thresholdExceeded: null,
        status: "UNASSESSABLE",
      },
      {
        targetKey: "ISSUE-YOUNG",
        ageDays: 1,
        thresholdExceeded: false,
        status: "WITHIN_THRESHOLD",
        threshold: { minimumBlockerAgeDays: 3 },
      },
    ]);
    expect(result.assessments.some((item) => item.targetKey === "ISSUE-CLOSED"))
      .toBe(false);
  });

  it("sorts and freezes detached results", () => {
    const input = request({
      blockers: [
        blocker({ targetKey: "Z-ISSUE" }),
        blocker({ targetKey: "A-ISSUE" }),
      ],
    });
    const result = evaluateBlockerAgeSignals(input);
    input.blockers[0]!.sourceDate = "2026-03-09";
    expect(result.assessments.map((item) => item.targetKey)).toEqual([
      "A-ISSUE",
      "Z-ISSUE",
    ]);
    expect(result.assessments[1]?.sourceDate).toBe("2026-03-07");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assessments)).toBe(true);
    expect(Object.isFrozen(result.assessments[0]?.threshold)).toBe(true);
  });

  it("fails closed for incomplete snapshots, duplicate blockers, invalid rules, and future dates", () => {
    const duplicate = blocker({ targetKey: "ISSUE-1" });
    const invalidSourceDate = blocker({
      sourceDate: null,
      sourceDateField: "openedAt",
    });
    for (const input of [
      { ...request(), blockerReadComplete: false },
      request({ blockers: [duplicate, duplicate] }),
      request({ timeZone: "Invalid/Timezone" }),
      request({ blockers: [blocker({ sourceDate: "2026-03-11" })] }),
      request({ blockers: [invalidSourceDate] }),
      request({
        threshold: {
          ruleKey: "blocker-age",
          ruleRevision: "blocker-age-v1",
          minimumBlockerAgeDays: 0,
        },
      }),
    ]) {
      expect(() => evaluateBlockerAgeSignals(input)).toThrow(
        "Invalid blocker age signal input",
      );
    }
  });
});
