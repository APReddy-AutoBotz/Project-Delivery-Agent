import { describe, expect, it, vi } from "vitest";
import {
  buildScheduleHealthAssessment,
  evaluateBlockerAgeSignals,
  type BlockerAgeSignalInput,
  type ScheduleHealthSnapshot,
} from "../packages/domain/src/index.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const scheduleInput: ScheduleHealthSnapshot = deepFreeze<ScheduleHealthSnapshot>({
  projectId: "10000000-0000-4000-8000-000000000006",
  projectRevision: 4,
  reportedStatus: "GREEN",
  assessedAt: "2026-09-29T10:00:00.000Z",
  milestones: [
    {
      id: "20000000-0000-4000-8000-000000000006",
      key: "MILESTONE-1",
      state: "OPEN",
      forecastEnd: "2026-09-28",
      plannedEnd: "2026-09-30",
    },
  ],
  workItems: [
    {
      id: "30000000-0000-4000-8000-000000000006",
      key: "WORK-1",
      state: "IN_PROGRESS",
      forecastEnd: null,
      plannedEnd: "2026-10-02",
    },
  ],
});

const blockerAgeInput: BlockerAgeSignalInput = deepFreeze<BlockerAgeSignalInput>({
  asOf: "2026-09-29T10:00:00.000Z",
  timeZone: "UTC",
  blockerReadComplete: true,
  threshold: {
    ruleKey: "blocker-age",
    ruleRevision: "1",
    minimumBlockerAgeDays: 5,
  },
  blockers: [
    {
      targetType: "RAID_ITEM",
      targetKey: "RAID-1",
      state: "OPEN",
      sourceDate: "2026-09-19",
      sourceDateField: "opened_at",
      source: { kind: "canonical_field" },
    },
  ],
});

describe("UNIT-HLT-006: provider-independent health calculation", () => {
  it("recomputes schedule and blocker-age results identically from the same frozen inputs", () => {
    const providerRequest = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("AI provider access is disabled for this test"),
    );
    try {
      const scheduleFirst = buildScheduleHealthAssessment(scheduleInput);
      const blockerAgeFirst = evaluateBlockerAgeSignals(blockerAgeInput);
      const scheduleSecond = buildScheduleHealthAssessment(scheduleInput);
      const blockerAgeSecond = evaluateBlockerAgeSignals(blockerAgeInput);

      expect(scheduleSecond).toEqual(scheduleFirst);
      expect(blockerAgeSecond).toEqual(blockerAgeFirst);
      expect(providerRequest).not.toHaveBeenCalled();
    } finally {
      providerRequest.mockRestore();
    }
  });
});
