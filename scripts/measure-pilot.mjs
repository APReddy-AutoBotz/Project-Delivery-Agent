import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requireFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some((name) => !Object.hasOwn(value, name)))
    throw new Error(`Invalid fields for ${label}.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value))
    throw new Error(`Expected UTC timestamp for ${label}.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.replace("Z", ".000Z"))
    throw new Error(`Invalid UTC timestamp for ${label}.`);
  return time;
}

function counts(value, fields, label) {
  const row = requireFields(value, fields, label);
  if (Object.values(row).some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new Error(`Expected nonnegative integer totals for ${label}.`);
  return row;
}

const measure = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });

function summarize(value, period) {
  const { from, until, effort, updates, risks } = requireFields(value,
    ["from", "until", "effort", "updates", "risks"], period);
  const start = timestamp(from, period + ".from");
  const end = timestamp(until, period + ".until");
  if (start >= end) throw new Error(`Expected a nonempty ${period} window.`);

  const { cycles, chasingMinutes, reportingMinutes } = counts(effort,
    ["cycles", "chasingMinutes", "reportingMinutes"], period + ".effort");
  const totalMinutes = chasingMinutes + reportingMinutes;
  if ((!cycles && totalMinutes) || !Number.isSafeInteger(totalMinutes))
    throw new Error(`Invalid ${period} effort totals.`);
  const { due, completed, onTime, activeProjects, currentVerifiedProjects } = counts(updates,
    ["due", "completed", "onTime", "activeProjects", "currentVerifiedProjects"], period + ".updates");
  if (onTime > completed || completed > due || currentVerifiedProjects > activeProjects)
    throw new Error(`Invalid ${period} update denominators.`);

  if (!Array.isArray(risks)) throw new Error(`Expected an array for ${period}.risks.`);
  const leads = risks.map((risk) => {
    const { detectedAt, scheduledReportAt } = requireFields(risk,
      ["detectedAt", "scheduledReportAt"], period + ".risk");
    const detection = timestamp(detectedAt, period + ".risk.detectedAt");
    const report = timestamp(scheduledReportAt, period + ".risk.scheduledReportAt");
    if (detection < start || detection >= end) throw new Error(`Risk detection outside the ${period} window.`);
    return (report - detection) / 60_000;
  }).sort((left, right) => left - right);
  const median = leads.length
    ? (leads[Math.floor((leads.length - 1) / 2)] + leads[Math.floor(leads.length / 2)]) / 2
    : null;

  return {
    from, until,
    chasingMinutesPerCycle: measure(chasingMinutes, cycles),
    reportingMinutesPerCycle: measure(reportingMinutes, cycles),
    totalMinutesPerCycle: measure(totalMinutes, cycles),
    completedUpdates: measure(completed, due),
    updatesOnTime: measure(onTime, due),
    projectsWithCurrentVerifiedUpdates: measure(currentVerifiedProjects, activeProjects),
    risksDetectedBeforeReport: measure(leads.filter((lead) => lead > 0).length, leads.length),
    medianRiskLeadMinutes: { observations: leads.length, value: median },
  };
}

export function measurePilot(input) {
  const { source, plan, baseline, observation } = requireFields(input, ["source", "plan", "baseline", "observation"], "pilot");
  if (source !== "synthetic" && source !== "observed") throw new Error("Invalid pilot source.");
  const agreement = requireFields(plan, ["pmoOwner", "includedProjects", "exclusions", "collectionMethod"], "plan");
  if (Object.values(agreement).some((entry) => typeof entry !== "string" || !entry.trim()))
    throw new Error("Fill in the PMO owner, included projects, exclusions and collection method.");
  const before = summarize(baseline, "baseline");
  const after = summarize(observation, "observation");
  if (before.until > after.from) throw new Error("The baseline must end before or at the start of observation.");
  return { source, baseline: before, observation: after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/measure-pilot.mjs <measurement.json>");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(measurePilot(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
    } catch (error) {
      console.error(`Pilot measurement failed (${error instanceof SyntaxError || error.code
        ? "could not read a JSON file" : error.message})`);
      process.exitCode = 1;
    }
  }
}
