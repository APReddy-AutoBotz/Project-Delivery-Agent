import { describe, expect, it } from "vitest";
import { measurePilot } from "../scripts/measure-pilot.mjs";
import example from "./fixtures/pilot-measurement.json";

describe("PILOT-001 aggregate measurement fixture", () => {
  it("calculates comparable effort, update and risk metrics from both windows", () => {
    const { source, baseline, observation } = measurePilot(example);
    expect(source).toBe("synthetic");
    expect(baseline).toMatchObject({
      chasingMinutesPerCycle: { numerator: 180, denominator: 2, value: 90 },
      reportingMinutesPerCycle: { numerator: 240, denominator: 2, value: 120 },
      totalMinutesPerCycle: { numerator: 420, denominator: 2, value: 210 },
      completedUpdates: { numerator: 4, denominator: 6, value: 4 / 6 },
      updatesOnTime: { numerator: 3, denominator: 6, value: 0.5 },
      projectsWithCurrentVerifiedUpdates: { numerator: 1, denominator: 3, value: 1 / 3 },
      risksDetectedBeforeReport: { numerator: 1, denominator: 2, value: 0.5 },
      medianRiskLeadMinutes: { observations: 2, value: 0 },
    });
    expect(observation).toMatchObject({
      totalMinutesPerCycle: { numerator: 240, denominator: 2, value: 120 },
      completedUpdates: { numerator: 6, denominator: 6, value: 1 },
      updatesOnTime: { numerator: 5, denominator: 6, value: 5 / 6 },
      projectsWithCurrentVerifiedUpdates: { numerator: 3, denominator: 3, value: 1 },
      risksDetectedBeforeReport: { numerator: 2, denominator: 3, value: 2 / 3 },
      medianRiskLeadMinutes: { observations: 3, value: 120 },
    });
    expect(JSON.stringify({ baseline, observation })).not.toContain(example.plan.pmoOwner);
  });

  it("reports unavailable measurements when the denominator is zero", () => {
    const input = structuredClone(example);
    input.baseline.effort = { cycles: 0, chasingMinutes: 0, reportingMinutes: 0 };
    input.baseline.updates = { due: 0, completed: 0, onTime: 0, activeProjects: 0, currentVerifiedProjects: 0 };
    input.baseline.risks = [];
    const { baseline } = measurePilot(input);
    expect(baseline.totalMinutesPerCycle).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(baseline.completedUpdates.value).toBeNull();
    expect(baseline.projectsWithCurrentVerifiedUpdates.value).toBeNull();
    expect(baseline.risksDetectedBeforeReport.value).toBeNull();
    expect(baseline.medianRiskLeadMinutes).toEqual({ observations: 0, value: null });
  });

  it("rejects overlapping windows, inconsistent counts and risks outside their window", () => {
    const input = structuredClone(example);
    input.observation.from = "2026-09-14T00:00:00Z";
    expect(() => measurePilot(input)).toThrow("The baseline must end");
    input.observation.from = example.observation.from;
    input.observation.updates.onTime = 7;
    expect(() => measurePilot(input)).toThrow("Invalid observation update denominators");
    input.observation.updates.onTime = example.observation.updates.onTime;
    input.observation.risks[0].detectedAt = example.observation.until;
    expect(() => measurePilot(input)).toThrow("Risk detection outside the observation window");
  });
});
