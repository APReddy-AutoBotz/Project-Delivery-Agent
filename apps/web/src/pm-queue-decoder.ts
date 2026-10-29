import type { PmActionQueue } from "@pdaa/domain";

// EXEC-026: defensive checks for fields rendered by this panel and its pointer
// ordering. Full domain and source-authority validation remains on the server.
const fail = (): never => { throw new Error("Invalid action queue presentation"); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const array = (value: unknown, maximum: number): unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail();
const string = (value: unknown): string => typeof value === "string" ? value : fail();
const integer = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) ? value : fail();
const revision = (value: unknown, minimum: number) => {
  const result = integer(value);
  if (result < minimum || result > 2147483647) fail();
};
const instant = (value: unknown) => {
  const result = string(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(result) || !Number.isFinite(Date.parse(result))) fail();
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === "string" && choices.includes(value as T) ? value as T : fail();
const scalar = (value: unknown) => {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))) fail();
};
const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const categories = ["UPDATE_FOLLOW_UP", "RECONCILIATION", "SCHEDULE_REVIEW", "EVIDENCE_REVIEW"] as const;
const identifier = (value: unknown) => {
  const id = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail();
  return id;
};
function fact(value: unknown) {
  const item = object(value), source = object(item.source);
  string(item.factType); string(item.field); scalar(item.value);
  oneOf(source.recordType, ["PROJECT", "MILESTONE", "WORK_ITEM"] as const); identifier(source.recordId);
  if (source.revision !== null) revision(source.revision, 0);
}
function signal(value: unknown) {
  const item = object(value), rule = object(item.rule);
  string(item.signalId); string(item.targetKey);
  oneOf(item.kind, ["OVERDUE_MILESTONE", "OVERDUE_WORK_ITEM", "SCHEDULE_COVERAGE"] as const);
  oneOf(item.state, ["ACTIVE", "CLEAR", "UNASSESSABLE"] as const);
  string(rule.key); string(rule.revision);
  for (const entry of array(rule.parameters, 16)) { const parameter = object(entry); string(parameter.name); scalar(parameter.value); }
  const facts = array(item.sourceFacts, 16);
  if (!facts.length) fail();
  for (const entry of facts) fact(entry);
  return item;
}
type Pointer = PmActionQueue["items"][number];
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const comparePointers = (left: Pointer, right: Pointer) => priorities.indexOf(left.priority) - priorities.indexOf(right.priority) ||
  categories.indexOf(left.category) - categories.indexOf(right.category) || compare(left.projectId, right.projectId) ||
  compare(left.facet, right.facet) || compare(left.key, right.key);
const fingerprint = (pointer: Pointer) => JSON.stringify([pointer.projectId, pointer.facet, pointer.index, pointer.key, pointer.priority, pointer.category]);

export function decodePmQueue(value: unknown): PmActionQueue {
  const queue = object(value), coverage = object(queue.coverage);
  if (queue.rankPolicyRevision !== "pm-review-order@1" || coverage.schedule !== "AVAILABLE" ||
      coverage.updateInformation !== "AVAILABLE_OR_UNCONFIGURED" || coverage.approvals !== "UNAVAILABLE" ||
      coverage.blockerAge !== "UNAVAILABLE" || coverage.otherCategories !== "UNAVAILABLE") fail();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) fail();
  const expected: Pointer[] = [], projects = new Set<string>();
  for (const entry of array(queue.projects, 25)) {
    const project = object(entry), projectId = identifier(project.projectId);
    const name = string(project.name);
    if (!name || name.length > 160 || projects.has(projectId)) fail();
    projects.add(projectId);
    const schedule = object(project.schedule), update = object(project.update);
    if (schedule.projectId !== projectId || update.projectId !== projectId || schedule.audience !== "project_manager" ||
        update.audience !== "project_manager" || schedule.coverage !== "SCHEDULE_ONLY" || schedule.sourceAuthority !== "NOT_ASSESSED" ||
        schedule.approvalItems !== "UNAVAILABLE" || update.approvalItems !== "UNAVAILABLE" ||
        schedule.rankPolicyRevision !== "advice-core@1") fail();
    instant(schedule.asOf); instant(update.asOf);
    const keys = new Set<string>();
    for (const [index, value] of array(schedule.items, 101).entries()) {
      const item = object(value), rule = object(item.triggeringRule), trigger = object(item.trigger);
      const key = string(item.concernKey), urgency = oneOf(item.urgency, priorities);
      const category = oneOf(item.category, ["RECONCILIATION", "SCHEDULE_REVIEW", "EVIDENCE_REVIEW"] as const);
      if (keys.has(key) || item.projectId !== projectId || item.classification !== "RULE_BASED_SUGGESTION" ||
          item.adviceRuleRevision !== "advice-core@1" || item.approvalRequired !== true ||
          item.assessedAt !== schedule.asOf || item.triggeredAt !== schedule.asOf || trigger.sourceAssessedAt !== schedule.asOf) fail();
      keys.add(key); string(item.suggestedAction); string(item.expectedOutcome); string(rule.key); string(rule.revision);
      if (trigger.kind === "DELIVERY_SIGNAL") {
        const source = signal(trigger.signal);
        const expectedCategory = source.state === "UNASSESSABLE" || source.kind === "SCHEDULE_COVERAGE" ? "EVIDENCE_REVIEW" : "SCHEDULE_REVIEW";
        if (source.state === "CLEAR" || category !== expectedCategory) fail();
      }
      else if (trigger.kind === "REPORTED_CALCULATED_MISMATCH") {
        const reported = object(trigger.reported), calculated = object(trigger.calculated);
        if (category !== "RECONCILIATION") fail();
        oneOf(reported.status, ["GREEN", "AMBER", "RED", "UNKNOWN"] as const);
        oneOf(calculated.status, ["GREEN", "AMBER", "RED", "UNKNOWN"] as const); fact(reported.sourceFact);
        for (const source of array(trigger.objectiveSignals, 100)) signal(source);
      } else fail();
      expected.push({ projectId, facet: "SCHEDULE", index, key, priority: urgency, category });
    }
    if (update.availability === "AVAILABLE") {
      const freshness = object(update.freshness), completeness = object(update.completeness);
      if (completeness.projectId !== projectId || completeness.assessedAt !== update.asOf || freshness.assessedAt !== update.asOf) fail();
      oneOf(freshness.state, ["CURRENT", "STALE"] as const);
      oneOf(freshness.sourceDateField, ["project.createdAt", "project.latestValidUpdateAt"] as const); instant(freshness.sourceDate);
      instant(update.thresholdAt); revision(update.policyRevision, 1);
      for (const value of array(completeness.factAssessments, 100)) {
        const item = object(value); string(item.factType); string(item.label);
        oneOf(item.state, ["CONFIRMED", "MISSING", "UNCONFIRMED"] as const);
        oneOf(item.sourceAuthorityStatus, ["RESOLVED", "UNKNOWN", "CONFLICTING", "AMBIGUOUS", "INCOMPLETE", "REVALIDATION_REQUIRED", "NO_POLICY", "POLICY_NOT_APPLICABLE"] as const);
        oneOf(item.conflict, ["NONE", "CONFLICTING"] as const);
      }
      for (const value of array(update.evidence, 1000)) {
        const item = object(value); string(item.factType); identifier(item.factId); identifier(item.versionId);
        identifier(item.evidenceId); identifier(item.sourceId); revision(item.sourceAccessRevision, 1);
        if (item.authorityRevision !== null) revision(item.authorityRevision, 1);
      }
      if (update.suggestion !== null) {
        const suggestion = object(update.suggestion);
        if (suggestion.category !== "UPDATE_FOLLOW_UP" || suggestion.priority !== "MEDIUM" || suggestion.ruleRevision !== "update-information-v1") fail();
        string(suggestion.ruleRevision); string(suggestion.suggestedAction); string(suggestion.expectedOutcome);
        expected.push({ projectId, facet: "UPDATE", index: null, key: "update-information", priority: "MEDIUM", category: "UPDATE_FOLLOW_UP" });
      }
    } else if (update.availability !== "UNCONFIGURED") fail();
  }
  expected.sort(comparePointers);
  const actual = array(queue.items, 500);
  if (actual.length !== expected.length) fail();
  for (const [index, value] of actual.entries()) {
    const item = object(value), projectId = identifier(item.projectId), facet = oneOf(item.facet, ["SCHEDULE", "UPDATE"] as const);
    const priority = oneOf(item.priority, priorities), category = oneOf(item.category, categories), key = string(item.key);
    if (facet === "SCHEDULE") integer(item.index);
    else if (item.index !== null) fail();
    const pointer = { projectId, facet, index: item.index, key, priority, category };
    if (fingerprint(pointer as Pointer) !== fingerprint(expected[index]!)) fail();
  }
  return value as PmActionQueue;
}
