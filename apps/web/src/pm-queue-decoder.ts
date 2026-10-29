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
  const timestamp = Date.parse(result);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(result) || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== result.slice(0, 10)) fail();
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
function blockerProof(value: unknown, expectedType: string, validity: "FINITE" | "UNTIL_SUPERSEDED") {
  const proof = object(value);
  if (proof.factType !== expectedType || proof.status !== "RESOLVED" || proof.provenance !== "HUMAN_CONFIRMED" ||
      proof.sourceType !== "human_statement" || proof.freshness !== "CURRENT" || proof.conflict !== "NONE" || proof.validity !== validity) fail();
  identifier(proof.factId); identifier(proof.policyId); identifier(proof.policyRevisionId);
  revision(proof.factRevision, 1); revision(proof.policyRevision, 1);
  const supports = array(proof.supports, 1000), evidence = new Set<string>(), versions = new Set<string>();
  if (!supports.length) fail();
  let prior = "";
  for (const value of supports) {
    const support = object(value), version = identifier(support.versionId), evidenceId = identifier(support.evidenceId);
    identifier(support.sourceId); revision(support.accessRevision, 1);
    if (versions.has(version) || evidence.has(evidenceId) || (prior && compare(prior, version) >= 0)) fail();
    versions.add(version); evidence.add(evidenceId); prior = version;
  }
}
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

export function decodeBlockerAge(value: unknown, projectId: string, audience: "project_manager" | "leadership"): PmActionQueue["projects"][number]["blockerAge"] {
  const blocker = object(value);
  if (blocker.projectId !== projectId || blocker.audience !== audience || blocker.ruleRevision !== "blocker-age@1" ||
      blocker.orderRevision !== "blocker-review-order@1" || blocker.timeZone !== "UTC") fail();
  instant(blocker.asOf);
  if (new TextEncoder().encode(JSON.stringify(blocker)).byteLength > 262144) fail();
  const blockerItems = array(blocker.items, 50);
  if (blocker.coverage === "UNASSESSABLE") {
    if (blocker.threshold !== null || blocker.inventory !== null || blocker.noOpenBlockers !== null || blockerItems.length) fail();
  } else {
    oneOf(blocker.coverage, ["COMPLETE", "PARTIAL"] as const);
    const threshold = object(blocker.threshold); revision(threshold.minimumBlockerAgeDays, 1); revision(threshold.revision, 1);
    const minimumAge = integer(threshold.minimumBlockerAgeDays);
    if (minimumAge > 3650) fail();
    if (blocker.coverage === "PARTIAL" ? blocker.noOpenBlockers !== null : typeof blocker.noOpenBlockers !== "boolean") fail();
    if (blocker.noOpenBlockers === true && blockerItems.length) fail();
    blockerProof(blocker.inventory, "project.open_blocker_inventory_complete", "FINITE");
    let previous = ""; const raidIds = new Set<string>();
    for (const value of blockerItems) {
      const item = object(value), key = string(item.key), raidId = identifier(item.raidItemId);
      const order = `${key}\u0000${raidId}`;
      const opened = string(item.openedAt), day = Date.parse(`${opened}T00:00:00.000Z`);
      const asOfDay = Date.parse(`${string(blocker.asOf).slice(0, 10)}T00:00:00.000Z`);
      if (!key || raidIds.has(raidId) || (previous && compare(previous, order) >= 0) || !/^\d{4}-\d\d-\d\d$/.test(opened) ||
          !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== opened ||
          item.sourceDateField !== "opened_at" || integer(item.ageDays) < minimumAge || item.ageDays !== (asOfDay - day) / 86400000) fail();
      raidIds.add(raidId);
      previous = order;
      oneOf(item.state, ["OPEN", "IN_PROGRESS"] as const);
      if (item.suggestedAction !== (audience === "project_manager" ? "Review the aged blocker and decide the next delivery action." : "Review the aged blocker and decide whether an intervention is needed.") ||
          item.expectedOutcome !== "A reviewed next step for the blocker and its delivery impact.") fail();
      blockerProof(item.classification, `raid_item.${raidId}.blocks_delivery`, "FINITE");
      blockerProof(item.openedAtProof, `raid_item.${raidId}.opened_at`, "UNTIL_SUPERSEDED");
    }
  }
  return value as PmActionQueue["projects"][number]["blockerAge"];
}

export function decodePmQueue(value: unknown): PmActionQueue {
  const queue = object(value), coverage = object(queue.coverage);
  if (queue.rankPolicyRevision !== "pm-review-order@1" || coverage.schedule !== "AVAILABLE" ||
      coverage.updateInformation !== "AVAILABLE_OR_UNCONFIGURED" || coverage.approvals !== "UNAVAILABLE" ||
      coverage.blockerAge !== "AVAILABLE_OR_UNASSESSABLE" || coverage.otherCategories !== "UNAVAILABLE") fail();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) fail();
  const expected: Pointer[] = [], projects = new Set<string>();
  let blockerCount = 0, priorProject = "";
  for (const entry of array(queue.projects, 25)) {
    const project = object(entry), projectId = identifier(project.projectId);
    const name = string(project.name);
    if (!name || name.length > 160 || projects.has(projectId)) fail();
    if (priorProject && compare(priorProject, projectId) >= 0) fail();
    priorProject = projectId;
    projects.add(projectId);
    const schedule = object(project.schedule), update = object(project.update);
    const blocker = decodeBlockerAge(project.blockerAge, projectId, "project_manager");
    blockerCount += blocker.items.length;
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
  if (actual.length + blockerCount > 500) fail();
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
