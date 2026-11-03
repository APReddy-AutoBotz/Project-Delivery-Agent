import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  BlockerAgeThresholdPolicyView,
  ScheduleHealthPolicyChange,
  ScheduleHealthPolicySnapshot,
  ScheduleHealthPolicyView,
  HealthAssessmentView,
} from "@pdaa/domain";
import { Button, Message, TextField } from "./components.js";
import { useHealthScope } from "./health-scope-context.js";
import type { HealthWriteLease } from "./health-scope-fence.js";

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
  policy,
  refresh,
}: {
  policy: BlockerAgeThresholdPolicyView | null;
  refresh: () => void;
}) {
  const scope = useHealthScope();
  const [saveError, setSaveError] = useState(false);
  const [minimumAge, setMinimumAge] = useState(
    policy ? String(policy.minimumBlockerAgeDays) : "",
  );
  const [auditHours, setAuditHours] = useState(
    policy ? String(policy.auditRetentionHours) : "",
  );
  const save = useMutation({
    retry: false,
    mutationFn: async ({ change, lease }: { change: ThresholdChange; lease: HealthWriteLease }) => {
      try {
        await scope.write(lease, "/admin/blocker-age-threshold-policy", { method: "POST", body: JSON.stringify(change) });
        setSaveError(false);
      } catch {
        if (scope.writeCurrent(lease)) setSaveError(true);
      } finally { scope.finishWrite(lease); }
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
          const lease = scope.beginWrite();
          if (!lease) return;
          try { save.mutate({ lease, change: {
            expectedRevision: policy?.revision ?? 0,
            minimumBlockerAgeDays: Number(minimumAge),
            auditRetentionHours: Number(auditHours),
          } }); } catch { scope.finishWrite(lease); }
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
          disabled={save.isPending || scope.reading || scope.atCapacity}
        >
          {save.isPending ? "Saving…" : "Save customer threshold"}
        </Button>
      </form>
      <p className="muted">
        A saved threshold applies to new assessments. Replays retain the threshold and revision already recorded.
      </p>
      {saveError && (
        <>
          <Message error>The save outcome could not be confirmed. Reload to check the current policy.</Message>
          <Button className="secondary" onClick={refresh}>
            Reload current threshold
          </Button>
        </>
      )}
    </div>
  );
}


function ScheduleHealthPolicyEditor({
  projectId,
  policy,
  refresh,
}: {
  projectId: string;
  policy: ScheduleHealthPolicyView;
  refresh: () => void;
}) {
  const scope = useHealthScope();
  const [saveError, setSaveError] = useState(false);
  const [timeZone, setTimeZone] = useState(policy.timeZone);
  const [defaultDays, setDefaultDays] = useState(
    String(policy.defaultMinimumOverdueDays),
  );
  const [overridesText, setOverridesText] = useState(
    JSON.stringify(policy.targetOverrides, null, 2),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const overridesId = "schedule-health-overrides-" + projectId;
  const overridesHelpId = overridesId + "-help";
  const save = useMutation({
    retry: false,
    mutationFn: async ({ change, lease }: { change: ScheduleHealthPolicyChange; lease: HealthWriteLease }) => {
      try {
        await scope.write(lease, "/projects/" + projectId + "/schedule-health-policy", { method: "POST", body: JSON.stringify(change) });
        setSaveError(false); setFormError(null);
      } catch {
        if (scope.writeCurrent(lease)) setSaveError(true);
      } finally { scope.finishWrite(lease); }
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
          const lease = scope.beginWrite();
          if (!lease) return;
          try { save.mutate({ lease, change: {
            expectedRevision: policy.revision,
            timeZone,
            defaultMinimumOverdueDays: Number(defaultDays),
            targetOverrides,
          } }); } catch { scope.finishWrite(lease); }
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
        <label className="grid gap-1 md:col-span-2" htmlFor={overridesId}>
          <span className="text-sm font-medium">Per-target threshold overrides (JSON)</span>
        </label>
        <textarea
          id={overridesId}
          aria-describedby={overridesHelpId}
          className="min-h-28 rounded-md border border-slate-300 p-2 font-mono text-sm md:col-span-2"
          value={overridesText}
          onChange={(event) => setOverridesText(event.target.value)}
          spellCheck={false}
        />
        <span id={overridesHelpId} className="muted md:col-span-2 min-w-0 break-words">
          Each entry uses targetType, targetKey, and minimumOverdueDays. Example: {"[{\"targetType\":\"MILESTONE\",\"targetKey\":\"MS-1\",\"minimumOverdueDays\":2}]"}
        </span>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button type="submit" className="primary" disabled={save.isPending || scope.reading || scope.atCapacity}>
            {save.isPending ? "Saving…" : "Save project schedule policy"}
          </Button>
          <span className="muted">Saved changes apply to new assessments. Existing evidence keeps its recorded revision.</span>
        </div>
      </form>
      {(formError || saveError) && (
        <>
          <Message error>{formError ?? "The save outcome could not be confirmed. Reload to check the current policy."}</Message>
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
  pmoAdmin,
  canInspectMilestone,
  visible = true,
}: {
  projectId: string;
  reportedStatus: string;
  pmoAdmin: boolean;
  canInspectMilestone: boolean;
  visible?: boolean;
}) {
  const scope = useHealthScope();
  const assessmentKey = ["health-assessment-latest", ...scope.key] as const;
  const thresholdKey = ["blocker-age-threshold-policy", ...scope.key] as const;
  const schedulePolicyKey = ["schedule-health-policy", ...scope.key] as const;
  const latest = useQuery({
    queryKey: assessmentKey,
    queryFn: ({ signal }) => scope.read<HealthAssessmentView | null>("/projects/" + projectId + "/health-assessments/latest", signal),
    enabled: visible && scope.ready,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const threshold = useQuery({
    queryKey: thresholdKey,
    queryFn: ({ signal }) => scope.read<BlockerAgeThresholdPolicyView | null>("/admin/blocker-age-threshold-policy", signal),
    enabled: visible && scope.ready && pmoAdmin,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const schedulePolicy = useQuery({
    queryKey: schedulePolicyKey,
    queryFn: ({ signal }) => scope.read<ScheduleHealthPolicyView>("/projects/" + projectId + "/schedule-health-policy", signal),
    enabled: visible && scope.ready && pmoAdmin,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const create = useMutation({
    retry: false,
    mutationFn: async ({ lease, key }: { lease: HealthWriteLease; key: string }) => {
      try {
        await scope.write(lease, "/projects/" + projectId + "/health-assessments", {
          method: "POST", body: JSON.stringify({ commandKey: key }),
        });
        scope.completeAssessment(lease, key);
      } catch { /* The shared owner retains any uncertain sent outcome. */ }
      finally { scope.finishWrite(lease); }
    },
  });

  const assessment = latest.isFetching || latest.isError ? undefined : latest.data;
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

  if (!visible || !scope.ready || !scope.current()) return <section className="panel">
    {scope.failed && visible ? <><p role="alert">Current health access could not be established.</p>
      <Button className="secondary" onClick={() => scope.recheck()}>Check access again</Button></>
      : <p role="status">{scope.writing ? "Updating health information…" : "Checking current health access…"}</p>}
  </section>;

  return (
    <section className="panel space-y-5" aria-labelledby="delivery-assessment-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="eyebrow">DELIVERY ASSESSMENT</span>
          <h2 id="delivery-assessment-heading">Schedule and blocker age</h2>
          <p className="muted">
            The reported project status remains separate from the saved schedule calculation and blocker-age coverage.
          </p>
          {canInspectMilestone && <p className="muted">
            <a href="#delivery-structure" onClick={(event) => { event.preventDefault(); if (scope.current()) document.getElementById("delivery-structure")?.focus(); }}>
              View the separate milestone completion check in delivery structure
            </a>. It has its own access checks and observation time; it is not part of this saved assessment.
          </p>}
        </div>
        <Button
          className="primary"
          disabled={!visible || !latest.isSuccess || latest.isFetching || create.isPending || scope.reading || scope.atCapacity || scope.assessmentCapacity}
          onClick={() => {
            if (!latest.isSuccess || latest.isFetching) return;
            const key = scope.assessmentCommand(); if (!key) return;
            const lease = scope.beginWrite(); if (!lease) return;
            try { create.mutate({ lease, key }); } catch { scope.finishWrite(lease); }
          }}
        >
          {create.isPending ? "Assessing…" : scope.pendingAssessment ? "Retry previous assessment" : "Run assessment"}
        </Button>
      </div>

      {scope.uncertain && <Message error>A previous health write may still have an unknown outcome. The refreshed information is a separate as-of check.</Message>}
      {(scope.atCapacity || scope.assessmentCapacity) && <Message error>Health actions are unavailable in this browser session; previously sent writes may still complete.</Message>}

      {pmoAdmin && (
        <section className="rounded-lg border border-slate-200 p-4" aria-labelledby="threshold-heading">
          <h3 id="threshold-heading">Customer-wide blocker-age threshold</h3>
          {threshold.isPending || threshold.isFetching ? (
            <p role="status">Loading the current customer threshold…</p>
          ) : threshold.isError ? (
            <>
              <Message error>{errorText(threshold.error)}</Message>
              <Button className="secondary" onClick={() => scope.refresh()}>
                Retry threshold access
              </Button>
            </>
          ) : (
            <ThresholdEditor
              key={threshold.data?.revision ?? "unconfigured"}
              policy={threshold.data ?? null}
              refresh={() => scope.refresh()}
            />
          )}
        </section>
      )}

          {pmoAdmin && (
            <section className="rounded-lg border border-slate-200 p-4 space-y-3" aria-labelledby="schedule-policy-heading">
              <h3 id="schedule-policy-heading">Project schedule overdue policy</h3>
              {schedulePolicy.isPending || schedulePolicy.isFetching ? (
                <p role="status">Loading the project schedule policy…</p>
              ) : schedulePolicy.isError ? (
                <>
                  <Message error>{errorText(schedulePolicy.error)}</Message>
                    <Button className="secondary" onClick={() => scope.refresh()}>
                    Retry policy access
                  </Button>
                </>
              ) : schedulePolicy.data ? (
                <ScheduleHealthPolicyEditor
                  key={schedulePolicy.data.revision}
                  projectId={projectId}
                  policy={schedulePolicy.data}
                  refresh={() => scope.refresh()}
                />
              ) : null}
            </section>
          )}

      {latest.isError && (
        <>
          <Message error>{errorText(latest.error)}</Message>
          <Button className="secondary" onClick={() => scope.refresh()}>
            Retry assessment access
          </Button>
        </>
      )}
      {latest.isPending || latest.isFetching ? (
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
                    <table className="w-full text-left" aria-label="Schedule overdue evidence">
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
                    <table className="w-full text-left" aria-label="Blocker-age RAID candidates">
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
