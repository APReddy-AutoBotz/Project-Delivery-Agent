import { describe, expect, it } from "vitest";
import {
  evaluateOverdueSignals,
  type OverdueSignalInput,
} from "../packages/domain/src/index.js";

type RecordInput = OverdueSignalInput["records"][number];
const canonicalSource = { kind: "canonical_field" } as const;
const externalSource = {
  kind: "external_record",
  sourceSystem: "jira",
  instanceKey: "JIRA-PRIMARY",
  externalType: "issue",
  externalId: "ENG-42",
  externalRevision: "17",
} as const;
const item = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  targetType: "WORK_ITEM",
  targetKey: "ENG-42",
  state: "OPEN",
  dueDate: "2026-06-01",
  dueDateField: "plannedEnd",
  source: { ...externalSource },
  threshold: {
    ruleRevision: "overdue-date-v1",
    minimumOverdueDays: 1,
  },
  ...overrides,
});
const request = (
  asOf: string,
  timeZone: string,
  records: RecordInput[] = [item()],
): OverdueSignalInput => ({ asOf, timeZone, records });

describe("UNIT-HLT-007: deterministic overdue signals", () => {
  it("changes at local midnight and retains the exact source date and rule inputs", () => {
    const before = evaluateOverdueSignals(
      request("2026-06-02T06:59:59.999Z", "America/Los_Angeles"),
    );
    expect(before.localDate).toBe("2026-06-01");
    expect(before.signals).toEqual([]);

    const after = evaluateOverdueSignals(
      request("2026-06-02T07:00:00.000Z", "America/Los_Angeles"),
    );
    expect(after.localDate).toBe("2026-06-02");
    expect(after.signals).toEqual([
      {
        kind: "OVERDUE",
        targetType: "WORK_ITEM",
        targetKey: "ENG-42",
        state: "OPEN",
        dueDate: "2026-06-01",
        dueDateField: "plannedEnd",
        source: externalSource,
        threshold: {
          ruleRevision: "overdue-date-v1",
          minimumOverdueDays: 1,
        },
        daysOverdue: 1,
      },
    ]);
    expect(after.asOf).toBe("2026-06-02T07:00:00.000Z");
    expect(after.timeZone).toBe("America/Los_Angeles");
  });

  it("applies a threshold at the exact local calendar-day boundary", () => {
    const record = item({
      threshold: {
        ruleRevision: "milestone-overdue-v3",
        minimumOverdueDays: 2,
      },
    });
    expect(
      evaluateOverdueSignals(
        request("2026-06-02T07:00:00.000Z", "America/Los_Angeles", [
          record,
        ]),
      ).signals,
    ).toEqual([]);
    expect(
      evaluateOverdueSignals(
        request("2026-06-03T07:00:00.000Z", "America/Los_Angeles", [
          record,
        ]),
      ).signals[0],
    ).toMatchObject({
      dueDate: "2026-06-01",
      daysOverdue: 2,
      threshold: {
        ruleRevision: "milestone-overdue-v3",
        minimumOverdueDays: 2,
      },
    });
  });

  it("uses a different local-day boundary in Asia/Kolkata", () => {
    expect(
      evaluateOverdueSignals(
        request("2026-06-01T18:29:59.999Z", "Asia/Kolkata"),
      ).signals,
    ).toEqual([]);
    const result = evaluateOverdueSignals(
      request("2026-06-01T18:30:00.000Z", "Asia/Kolkata"),
    );
    expect(result.localDate).toBe("2026-06-02");
    expect(result.signals[0]).toMatchObject({
      dueDate: "2026-06-01",
      daysOverdue: 1,
      source: externalSource,
    });
  });

  it("counts local calendar days across daylight-saving transitions", () => {
    const record = item({
      targetType: "MILESTONE",
      targetKey: "MS-1",
      dueDate: "2026-03-07",
      dueDateField: "forecastEnd",
      source: canonicalSource,
      threshold: {
        ruleRevision: "overdue-date-v1",
        minimumOverdueDays: 2,
      },
    });
    expect(
      evaluateOverdueSignals(
        request("2026-03-09T03:59:59.999Z", "America/New_York", [record]),
      ).signals,
    ).toEqual([]);
    const result = evaluateOverdueSignals(
      request("2026-03-09T04:00:00.000Z", "America/New_York", [record]),
    );
    expect(result.localDate).toBe("2026-03-09");
    expect(result.signals[0]).toMatchObject({
      kind: "OVERDUE",
      targetType: "MILESTONE",
      targetKey: "MS-1",
      dueDate: "2026-03-07",
      dueDateField: "forecastEnd",
      source: canonicalSource,
      daysOverdue: 2,
    });
  });

  it("does not signal due dates today, missing dates, completed work or cancelled work", () => {
    const records = [
      item(),
      item({
        targetKey: "ENG-43",
        dueDate: null,
      }),
      item({
        targetKey: "ENG-44",
        state: "COMPLETE",
      }),
      item({
        targetKey: "ENG-45",
        state: "CANCELLED",
      }),
    ];
    const result = evaluateOverdueSignals(
      request("2026-06-01T12:00:00.000Z", "UTC", records),
    );
    expect(result.localDate).toBe("2026-06-01");
    expect(result.signals).toEqual([]);
  });

  it("sorts output independently of input ordering and freezes detached results", () => {
    const first = item({
      targetKey: "ENG-45",
      source: { kind: "canonical_field" },
    });
    const second = item();
    const records = [first, second];
    const result = evaluateOverdueSignals(
      request("2026-06-03T12:00:00.000Z", "UTC", records),
    );
    const reversed = evaluateOverdueSignals(
      request("2026-06-03T12:00:00.000Z", "UTC", [...records].reverse()),
    );
    expect(result).toEqual(reversed);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.signals)).toBe(true);
    expect(Object.isFrozen(result.signals[0]?.source)).toBe(true);
    if (second.source.kind !== "external_record")
      throw new Error("Expected external source fixture");
    second.source.externalRevision = "18";
    expect(
      result.signals.find((signal) => signal.targetKey === "ENG-42")?.source,
    ).toMatchObject({ externalRevision: "17" });
  });

  it("rejects invalid IANA zones, dates, timestamps and duplicate record identities safely", () => {
    for (const input of [
      request("2026-06-02T07:00:00.000Z", "Mars/Phobos"),
      request("2026-06-02T07:00:00.000Z", "UTC", [
        item({ dueDate: "2026-02-30" }),
      ]),
      request("2026-02-30T07:00:00.000Z", "UTC"),
      request("2026-06-02T07:00:00Z", "UTC"),
      request("2026-06-02T07:00:00.000Z", "UTC", [
        item(),
        item(),
      ]),
    ]) {
      expect(() => evaluateOverdueSignals(input)).toThrow(
        "Invalid overdue signal input",
      );
    }
  });
});
