import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BlockerAgeThresholdPolicyView,
  ScheduleHealthPolicyChange,
  ScheduleHealthPolicySnapshot,
  ScheduleHealthPolicyView,
  HealthAssessmentView,
} from "@pdaa/domain";
import { Button, Message, TextField } from "./components.js";
import type { RequestFn } from "./canonical-project.js";

type Candidate = {
  key: string;
  kind: string;
  state: string;
  outcome: string;
  reason: string | null;
  classification?: { reason?: string | null };
  openedAt?: { status?: string; value?: unknown; reason?: string | null } | null;
};
type AgeSignal = {
  targetKey: string;
  sourceDate: string | null;
  ageDays: number | null;
  status: string;
  threshold: { minimumBlockerAgeDays: number };
};
type AgeResult = {
  coverage: "COMPLETE" | "PARTIAL" | "UNASSESSABLE";
  noOpenBlockers: boolean | null;
  asOf: string;
  thresholdRevision: number | null;
  minimumBlockerAgeDays?: number;
  assessedBlockerCount: number;
  unknownCandidateCount: number;
  agedBlockerCount: number;
  assessments: AgeSignal[];
};
type ScheduleSignal = {
  kind: string;
  targetKey: string;
  state: string;
  severity: string;
  rule?: { parameters?: Array<{ name: string; value: unknown }> };
  sourceFacts?: Array<{ field: string; value: unknown }>;
};
type AssessmentResult = {
  calculated?: { status?: string };
  objectiveSignals?: ScheduleSignal[];
  blockerAge?: AgeResult;
};
type AssessmentInput = {
  scheduleHealthPolicy?: ScheduleHealthPolicySnapshot;
  blockerAge?: {
    asOf?: string;
    reason?: string;
    gates?: { inventoryAttested?: boolean };
    candidates?: Candidate[];
    threshold?: { minimumBlockerAgeDays?: number; revision?: number } | null;
  };
};
type ThresholdChange = {
  expectedRevision: number;
  minimumBlockerAgeDays: number;
  auditRetentionHours: number;
};

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}
function reasonText(reason: string | null | undefined) {
  if (!reason) return "Authority has not resolved this candidate.";
  const known: Record<string, string> = {
    FACT_MISSING: "A current classification fact is missing.",
    UNKNOWN: "No current authorized fact resolved this item.",
    NO_POLICY: "No current source-authority policy is configured.",
    REVALIDATION_REQUIRED: "Source access must be restored and revalidated.",
    SOURCE_AUTHORITY_NOT_CURRENT: "The source fact is not current under its authority policy.",
    FUTURE_OPENED_AT: "The opened date is later than the assessment time.",
    VALUE_TYPE_MISMATCH: "The source fact has the wrong value type.",
    AUTHORITY_UNAVAILABLE: "The authority snapshot could not be resolved.",
    THRESHOLD_NOT_CONFIGURED: "A customer blocker-age threshold has not been configured.",
    RAID_SNAPSHOT_OVER_LIMIT: "The active RAID inventory exceeds the assessment limit.",
    SOURCE_HISTORY_OVER_LIMIT: "The source history exceeds the assessment limit.",
    CANONICAL_SNAPSHOT_UNAVAILABLE: "The canonical RAID inventory is unavailable.",
    ENVELOPE_BOUND_EXCEEDED: "The evidence exceeded the saved assessment size limit.",
  };
  return known[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

function ThresholdEditor({
  request,
  policy,
  refresh,
}: {
  request: RequestFn;
  policy: BlockerAgeThresholdPolicyView | null;
  refresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [minimumAge, setMinimumAge] = useState(
    policy ? String(policy.minimumBlockerAgeDays) : "",
  );
  const [auditHours, setAuditHours] = useState(
    policy ? String(policy.auditRetentionHours) : "",
  );
  const key = ["blocker-age-threshold-policy"] as const;
  const save = useMutation({
    mutationFn: (change: ThresholdChange) =>
      request<BlockerAgeThresholdPolicyView>(
        "/admin/blocker-age-threshold-policy",
        { method: "POST", body: JSON.stringify(change) },
      ),
    onSuccess: (value) => {
      queryClient.setQueryData(key, value);
    },
  });
  return (
    <div className="space-y-3">
      {policy ? (
        <p className="muted">
          Current revision {policy.revision}: blockers age after{" "}
          {policy.minimumBlockerAgeDays} UTC calendar days. Audit retention is{" "}
          {policy.auditRetentionHours} hours.
        </p>
      ) : (
        <p className="muted">
          Set both values before blocker age can be assessed. No threshold is assumed.
        </p>
      )}
      <form
        className="grid gap-3 md:grid-cols-3 md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({
            expectedRevision: policy?.revision ?? 0,
            minimumBlockerAgeDays: Number(minimumAge),
            auditRetentionHours: Number(auditHours),
          });
        }}
      >
        <TextField
          label="Minimum blocker age (UTC calendar days)"
          type="number"
          min={1}
          max={3650}
          step={1}
          required
          value={minimumAge}
          onChange={(event) => setMinimumAge(event.currentTarget.value)}
        />
        <TextField
          label="Threshold audit retention (hours)"
          type="number"
          min={1}
          max={87600}
          step={1}
          required
          value={auditHours}
          onChange={(event) => setAuditHours(event.currentTarget.value)}
        />
        <Button
          type="submit"
          className="primary"
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save customer threshold"}
        </Button>
      </form>
      <p className="muted">
        A saved threshold applies to new assessments. Replays retain the threshold and revision already recorded.
      </p>
      {save.isError && (
        <>
          <Message error>{errorText(save.error)}</Message>
          <Button className="secondary" onClick={refresh}>
            Reload current threshold
          </Button>
        </>
      )}
    </div>
  );
}


function ScheduleHealthPolicyEditor({
  request,
  projectId,
  policy,
  refresh,
}: {
  request: RequestFn;
  projectId: string;
  policy: ScheduleHealthPolicyView;
  refresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [timeZone, setTimeZone] = useState(policy.timeZone);
  const [defaultDays, setDefaultDays] = useState(
    String(policy.defaultMinimumOverdueDays),
  );
  const [overridesText, setOverridesText] = useState(
    JSON.stringify(policy.targetOverrides, null, 2),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const key = ["schedule-health-policy", projectId] as const;
  const save = useMutation({
    mutationFn: (change: ScheduleHealthPolicyChange) =>
      request<ScheduleHealthPolicyView>(
        "/projects/" + projectId + "/schedule-health-policy",
        { method: "POST", body: JSON.stringify(change) },
      ),
    onSuccess: (value) => {
      queryClient.setQueryData(key, value);
      setFormError(null);
    },
  });
  return (
    <div className="space-y-3">
      <p className="muted">
        Schedule health policy revision {policy.revision}: {policy.timeZone}, overdue after{" "}
        {policy.defaultMinimumOverdueDays} local calendar day(s).
        {policy.changedBy ? " Last changed by " + policy.changedBy + "." : " Using the UTC one-day system default."}
      </p>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          let targetOverrides: ScheduleHealthPolicyChange["targetOverrides"];
          try {
            const parsed: unknown = JSON.parse(overridesText);
            if (!Array.isArray(parsed)) throw new Error("Overrides must be a JSON array.");
            targetOverrides = parsed as ScheduleHealthPolicyChange["targetOverrides"];
          } catch {
            setFormError("Enter target overrides as a valid JSON array.");
            return;
          }
          save.mutate({
            expectedRevision: policy.revision,
            timeZone,
            defaultMinimumOverdueDays: Number(defaultDays),
            targetOverrides,
          });
        }}
      >
        <TextField
          label="Schedule health time zone (IANA)"
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
        />
        <TextField
          label="Default overdue threshold (local calendar days)"
          type="number"
          min={1}
          max={3650}
          value={defaultDays}
          onChange={(event) => setDefaultDays(event.target.value)}
        />
        <label className="grid gap-1 md:col-span-2">
          <span className="text-sm font-medium">Per-target threshold overrides (JSON)</span>
          <textarea
            className="min-h-28 rounded-md border border-slate-300 p-2 font-mono text-sm"
            value={overridesText}
            onChange={(event) => setOverridesText(event.target.value)}
            spellCheck={false}
          />
          <span className="muted">
            Each entry uses targetType, targetKey, and minimumOverdueDays. Example: {"[{\"targetType\":\"MILESTONE\",\"targetKey\":\"MS-1\",\"minimumOverdueDays\":2}]"}
          </span>
        </label>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button className="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save project schedule policy"}
          </Button>
          <span className="muted">Saved changes apply to new assessments. Existing evidence keeps its recorded revision.</span>
        </div>
      </form>
      {(formError || save.isError) && (
        <>
          <Message error>{formError ?? errorText(save.error)}</Message>
          <Button className="secondary" onClick={refresh}>
            Reload current policy
          </Button>
        </>
      )}
    </div>
  );
}

export function HealthAssessmentPanel({
  projectId,
  reportedStatus,
  request,
  pmoAdmin,
  visible = true,
}: {
  projectId: string;
  reportedStatus: string;
  request: RequestFn;
  pmoAdmin: boolean;
  visible?: boolean;
}) {
  const queryClient = useQueryClient();
  const assessmentKey = ["health-assessment-latest", projectId] as const;
  const thresholdKey = ["blocker-age-threshold-policy"] as const;
  const schedulePolicyKey = ["schedule-health-policy", projectId] as const;
  const latest = useQuery({
    queryKey: assessmentKey,
    queryFn: () =>
      request<HealthAssessmentView | null>(
        "/projects/" + projectId + "/health-assessments/latest",
      ),
    enabled: visible,
    refetchOnWindowFocus: false,
  });
  const threshold = useQuery({
    queryKey: thresholdKey,
    queryFn: () =>
      request<BlockerAgeThresholdPolicyView | null>(
        "/admin/blocker-age-threshold-policy",
      ),
    enabled: visible && pmoAdmin,
    refetchOnWindowFocus: false,
  });
  const schedulePolicy = useQuery({
    queryKey: schedulePolicyKey,
    queryFn: () =>
      request<ScheduleHealthPolicyView>(
        "/projects/" + projectId + "/schedule-health-policy",
      ),
    enabled: visible && pmoAdmin,
    refetchOnWindowFocus: false,
  });
  const create = useMutation({
    mutationFn: () =>
      request<HealthAssessmentView>(
        "/projects/" + projectId + "/health-assessments",
        {
          method: "POST",
          body: JSON.stringify({ commandKey: globalThis.crypto.randomUUID() }),
        },
      ),
    onSuccess: (value) => {
      queryClient.setQueryData(assessmentKey, value);
    },
  });

  const assessment = latest.data;
  const result = assessment?.result as AssessmentResult | null | undefined;
  const input = assessment?.input as AssessmentInput | null | undefined;
  const scheduleSignals =
    result?.objectiveSignals?.filter((signal) =>
      signal.kind === "OVERDUE_MILESTONE" || signal.kind === "OVERDUE_WORK_ITEM",
    ) ?? [];
  const age = result?.blockerAge;
  const ageInput = input?.blockerAge;
  const candidates = ageInput?.candidates ?? [];
  const signals = new Map(
    age?.assessments.map((signal) => [signal.targetKey, signal]) ?? [],
  );

  return (
    <section className="panel space-y-5" aria-labelledby="delivery-assessment-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="eyebrow">DELIVERY ASSESSMENT</span>
          <h2 id="delivery-assessment-heading">Schedule and blocker age</h2>
          <p className="muted">
            The reported project status remains separate from the saved schedule calculation and blocker-age coverage.
          </p>
        </div>
        <Button
          className="primary"
          disabled={!visible || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Assessing…" : "Run assessment"}
        </Button>
      </div>

      {pmoAdmin && (
        <section className="rounded-lg border border-slate-200 p-4" aria-labelledby="threshold-heading">
          <h3 id="threshold-heading">Customer-wide blocker-age threshold</h3>
          {threshold.isPending ? (
            <p role="status">Loading the current customer threshold…</p>
          ) : threshold.isError ? (
            <>
              <Message error>{errorText(threshold.error)}</Message>
              <Button className="secondary" onClick={() => void threshold.refetch()}>
                Retry threshold access
              </Button>
            </>
          ) : (
            <ThresholdEditor
              key={threshold.data?.revision ?? "unconfigured"}
              request={request}
              policy={threshold.data ?? null}
              refresh={() => void threshold.refetch()}
            />
          )}
        </section>
      )}

          {pmoAdmin && (
            <section className="rounded-lg border border-slate-200 p-4 space-y-3" aria-labelledby="schedule-policy-heading">
              <h3 id="schedule-policy-heading">Project schedule overdue policy</h3>
              {schedulePolicy.isPending ? (
                <p role="status">Loading the project schedule policy…</p>
              ) : schedulePolicy.isError ? (
                <>
                  <Message error>{errorText(schedulePolicy.error)}</Message>
                  <Button className="secondary" onClick={() => void schedulePolicy.refetch()}>
                    Retry policy access
                  </Button>
                </>
              ) : schedulePolicy.data ? (
                <ScheduleHealthPolicyEditor
                  key={schedulePolicy.data.revision}
                  request={request}
                  projectId={projectId}
                  policy={schedulePolicy.data}
                  refresh={() => void schedulePolicy.refetch()}
                />
              ) : null}
            </section>
          )}

      {create.isError && <Message error>{errorText(create.error)}</Message>}
      {latest.isError && (
        <>
          <Message error>{errorText(latest.error)}</Message>
          <Button className="secondary" onClick={() => void latest.refetch()}>
            Retry assessment access
          </Button>
        </>
      )}
      {latest.isPending ? (
        <p role="status">Checking the latest assessment…</p>
      ) : !assessment ? (
        !latest.isError && (
          <p className="muted">No saved assessment yet. Run an assessment to capture the current schedule and blocker-age evidence.</p>
        )
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="muted">Reported status</dt>
              <dd>{reportedStatus} · unchanged</dd>
            </div>
            <div>
              <dt className="muted">Schedule calculation</dt>
              <dd>{assessment.contentAvailable ? (result?.calculated?.status ?? "Unavailable") : "Hidden"}</dd>
            </div>
            <div>
              <dt className="muted">Assessment coverage</dt>
              <dd>{assessment.coverage.replaceAll("_", " ").toLowerCase()}</dd>
            </div>
            <div>
              <dt className="muted">Assessment time</dt>
              <dd>{assessment.assessedAt} UTC</dd>
            </div>
          </dl>
          {assessment.contentAvailable ? (
            <>
              <section className="space-y-3" aria-labelledby="schedule-overdue-heading">
                <div>
                  <h3 id="schedule-overdue-heading">Schedule overdue evidence</h3>
                  {input?.scheduleHealthPolicy ? (
                    <p className="muted">
                      Policy revision {input.scheduleHealthPolicy.revision} ·{" "}
                      {input.scheduleHealthPolicy.timeZone} · default threshold{" "}
                      {input.scheduleHealthPolicy.defaultMinimumOverdueDays} local day(s)
                    </p>
                  ) : (
                    <p className="muted">
                      This historical assessment predates saved project schedule policies and used UTC with a one-day threshold.
                    </p>
                  )}
                </div>
                {scheduleSignals.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th scope="col">Target</th>
                          <th scope="col">State</th>
                          <th scope="col">Selected due date</th>
                          <th scope="col">Assessed local date</th>
                          <th scope="col">Threshold</th>
                          <th scope="col">Days overdue</th>
                          <th scope="col">Schedule health time zone</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scheduleSignals.map((signal) => {
                          const facts = new Map(signal.sourceFacts?.map((fact) => [fact.field, fact.value]) ?? []);
                          const parameters = new Map(signal.rule?.parameters?.map((parameter) => [parameter.name, parameter.value]) ?? []);
                          const show = (value: unknown) => value === null || value === undefined ? "—" : String(value);
                          return (
                            <tr key={signal.kind + ":" + signal.targetKey}>
                              <th scope="row">{signal.targetKey} · {signal.kind === "OVERDUE_MILESTONE" ? "Milestone" : "Work item"}</th>
                              <td>{signal.state} · {signal.severity}</td>
                              <td>{show(facts.get("selectedDueDate"))} · {show(facts.get("selectedDateField"))}</td>
                              <td>{show(parameters.get("assessedLocalDate"))}</td>
                              <td>{show(parameters.get("minimumOverdueDays"))} local day(s)</td>
                              <td>{show(parameters.get("daysOverdue"))}</td>
                              <td>{show(parameters.get("timeZone"))}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Message>No milestone or work-item schedule targets were included.</Message>
                )}
              </section>
              {age ? (
              <div className="space-y-4" aria-live="polite">
                <div>
                  <h3>Blocker-age coverage: {age.coverage.toLowerCase()}</h3>
                  {age.coverage === "COMPLETE" && age.noOpenBlockers === true ? (
                    <Message>
                      No open blockers were classified in the current, source-authorized complete inventory.
                    </Message>
                  ) : age.coverage === "PARTIAL" ? (
                    <Message>
                      {age.assessedBlockerCount} blocker(s) were assessed;{" "}
                      {age.unknownCandidateCount} candidate(s) remain unresolved. No clear-inventory conclusion is available.
                    </Message>
                  ) : age.coverage === "UNASSESSABLE" ? (
                    <Message>
                      Blocker age is unassessable. The schedule result above remains separate.
                    </Message>
                  ) : (
                    <p className="muted">
                      {age.assessedBlockerCount} blocker(s) assessed;{" "}
                      {age.agedBlockerCount} meet or exceed the threshold.
                    </p>
                  )}
                </div>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <dt className="muted">UTC as of</dt>
                    <dd>{age.asOf}</dd>
                  </div>
                  <div>
                    <dt className="muted">Minimum age</dt>
                    <dd>
                      {age.minimumBlockerAgeDays ??
                        ageInput?.threshold?.minimumBlockerAgeDays ??
                        "Not configured"}{" "}
                      days
                    </dd>
                  </div>
                  <div>
                    <dt className="muted">Threshold revision</dt>
                    <dd>{age.thresholdRevision ?? "Not configured"}</dd>
                  </div>
                </dl>
                {candidates.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th scope="col">RAID item</th>
                          <th scope="col">Kind</th>
                          <th scope="col">State</th>
                          <th scope="col">Opened at</th>
                          <th scope="col">Age outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((candidate) => {
                          const signal = signals.get(candidate.key);
                          const opened =
                            candidate.openedAt?.status === "RESOLVED" &&
                            typeof candidate.openedAt.value === "string"
                              ? candidate.openedAt.value
                              : "Unresolved";
                          const reason =
                            candidate.reason ??
                            candidate.openedAt?.reason ??
                            candidate.classification?.reason;
                          return (
                            <tr key={candidate.key}>
                              <th scope="row">{candidate.key}</th>
                              <td>{candidate.kind}</td>
                              <td>{candidate.state}</td>
                              <td>{opened}</td>
                              <td>
                                {signal ? (
                                  <span>
                                    {signal.status.replaceAll("_", " ")} ·{" "}
                                    {signal.ageDays ?? "—"} days · threshold{" "}
                                    {signal.threshold.minimumBlockerAgeDays}
                                  </span>
                                ) : candidate.outcome === "EXCLUDED" ? (
                                  <span>Excluded by current authorized classification</span>
                                ) : (
                                  <span>
                                    {candidate.outcome.replaceAll("_", " ")}:{" "}
                                    {reasonText(reason)}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : age.coverage === "COMPLETE" && age.noOpenBlockers ? (
                  <p className="muted">The current attested inventory has no active RAID candidates.</p>
                ) : (
                  <p className="muted">
                    No candidate details are available for this assessment.
                  </p>
                )}
              </div>
            ) : assessment.coverage === "SCHEDULE_ONLY" ? (
              <Message>
                This saved assessment contains schedule coverage only. Run a new assessment to calculate blocker-age coverage.
              </Message>
            ) : (
              <Message>
                No blocker-age result is available in this saved assessment.
              </Message>
              )}
            </>
          ) : (
            <Message>
              Assessment metadata is available, but its evidence content is hidden because current source access no longer permits delivery or its retention window has ended.
            </Message>
          )}
          {assessment.contentAvailable && ageInput?.reason && (
            <p className="muted">{reasonText(ageInput.reason)}</p>
          )}
          <p className="muted">
            Assessment {assessment.assessmentId} · rule {assessment.ruleRevision} · threshold audit changes are retained for their configured window.
          </p>
        </div>
      )}
    </section>
  );
}
