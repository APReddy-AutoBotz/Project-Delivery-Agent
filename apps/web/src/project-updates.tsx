import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Message, TextField } from "./components.js";
import type { RequestFn } from "./canonical-project.js";
import { ProjectUpdateCaptureHistory } from "./project-update-response.js";
import { decodePolicy, type Policy } from "./project-update-policy-decoder.js";
import { projectPolicyWrites } from "./project-policy-write-registry.js";

type RequiredFact = { factType: string; label: string };
type FactState = RequiredFact & {
  state: "CONFIRMED" | "MISSING" | "UNCONFIRMED";
  reasonCodes: string[];
};
type Preview = {
  id: string;
  revision: number;
  createdAt: string;
  project: { id: string; code: string; name: string };
  reportedStatus: string;
  policyRevision: number;
  assessedAt: string;
  freshnessThresholdAt: string;
  sourceDateField: string;
  sourceDate: string;
  timestampBasis: string;
  completenessState: "COMPLETE" | "INCOMPLETE";
  freshnessState: "CURRENT" | "STALE";
  requiredFacts: FactState[];
  evidence: Array<{
    factType: string;
    timestampBasis: string;
    observedAt: string;
    effectiveAt: string;
  }>;
};
type SchedulePreview = {
  assessmentId: string;
  assessmentPolicyRevision: number;
  policyRevision: number;
  asOf: string;
  timeZone: string;
  sourceDate: string;
  sourceDateField: string;
  sourceTimeBasis: string;
  logicalDueAt: string;
  requestEligibleAt: string;
  events: Array<{
    kind: "REQUEST" | "REMINDER" | "ESCALATION";
    offsetBusinessDays: number;
    recipientSubject: string;
    scheduledAt: string;
    localAt: string;
    utcOffset: string;
  }>;
};
type Assessment = {
  project: { id: string; code: string; name: string; reportedStatus: string };
  assessedAt: string;
  policy: Policy;
  completeness: {
    state: "COMPLETE" | "INCOMPLETE";
    confirmedCount: number;
    requiredCount: number;
    factAssessments: FactState[];
  };
  freshness: {
    state: "CURRENT" | "STALE";
    sourceDateField: string;
    sourceDate: string;
    freshnessWindowSeconds: number;
    exceededByMilliseconds: number;
  };
  obligation: { id: string; state: "OPEN" | "SUPERSEDED"; dueAt: string } | null;
  preview: Preview | null;
  knownPosition: Array<{
    factType: string;
    label: string;
    value: unknown;
    versionId: string;
    evidenceId: string;
    sourceId: string;
    sourceAccessRevision: number;
    authorityRevision: number | null;
    observedAt: string;
    effectiveAt: string;
    timestampBasis: string;
  }>;
};

export function ProjectUpdates({
  projectId,
  reportedStatus,
  request,
  pmoAdmin,
  visible,
  admissionScope,
  isCurrentScope,
  writeOwner,
}: {
  projectId: string;
  reportedStatus: string;
  request: RequestFn;
  pmoAdmin: boolean;
  visible: boolean;
  admissionScope: string;
  isCurrentScope: () => boolean;
  writeOwner: string;
}) {
  const queryClient = useQueryClient();
  const policyQuery = useQuery({
    queryKey: ["project-update-policy", projectId, admissionScope],
    queryFn: async () => decodePolicy(await request<unknown>(`/projects/${projectId}/project-update-policy`, {}, 65_536, undefined, undefined, undefined, 200), projectId),
    enabled: visible,
    retry: false,
  });
  const latestQuery = useQuery({
    queryKey: ["project-update-latest", projectId, admissionScope],
    queryFn: () => request<Assessment | null>(`/projects/${projectId}/project-update-assessments/latest`),
    enabled: visible,
    retry: false,
  });
  const [windowSeconds, setWindowSeconds] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [owner, setOwner] = useState("");
  const [requiredFactsText, setRequiredFactsText] = useState("");
  const [scheduledScanEnabled, setScheduledScanEnabled] = useState(false);
  const [reminderOffsets, setReminderOffsets] = useState("");
  const [escalationAfter, setEscalationAfter] = useState("0");
  const [escalationRecipient, setEscalationRecipient] = useState("");
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false), operationEpoch = useRef(0), draftEpoch = useRef(0);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const writeVersion = React.useSyncExternalStore(projectPolicyWrites.subscribe, projectPolicyWrites.snapshot, projectPolicyWrites.snapshot);
  const renderedDraftEpoch = draftEpoch.current, renderedOperationEpoch = operationEpoch.current;
  const writeState = projectPolicyWrites.state(writeOwner);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const policyRevision = policyQuery.data?.revision ?? 0;
  const draftConflict = draftDirty && draftRevision !== null && draftRevision !== policyRevision;
  const currentRevision = () => {
    const policy = queryClient.getQueryState<Policy | null>(["project-update-policy", projectId, admissionScope]);
    if (!policy || policy.status !== "success" || policy.fetchStatus !== "idle") return null;
    if (policy.data === null) return 0;
    return policy.data && policy.data.projectId === projectId && Number.isSafeInteger(policy.data.revision) && policy.data.revision > 0
      ? policy.data.revision : null;
  };
  const current = () => {
    const policy = queryClient.getQueryState(["project-update-policy", projectId, admissionScope]);
    const latest = queryClient.getQueryState(["project-update-latest", projectId, admissionScope]);
    return isCurrentScope() && policy?.status === "success" && policy.fetchStatus === "idle" &&
      latest?.status === "success" && latest.fetchStatus === "idle";
  };

  useEffect(() => {
    if (!visible || policyQuery.isPending || policyQuery.isFetching || policyQuery.isError || draftDirty || draftRevision === policyRevision) return;
    draftEpoch.current++; setDraftRevision(policyRevision);
    const policy = policyQuery.data;
    if (!policy) {
      setWindowSeconds("");
      setTimeZone("");
      setOwner("");
      setRequiredFactsText("");
      setScheduledScanEnabled(false);
      setReminderOffsets("");
      setEscalationAfter("0");
      setEscalationRecipient("");
      setQuietStart("");
      setQuietEnd("");
      setSchedulePreview(null);
      return;
    }
    setWindowSeconds(String(policy.freshnessWindowSeconds));
    setTimeZone(policy.timeZone);
    setOwner(policy.responsibleSubject);
    setRequiredFactsText(
      policy.requiredFacts.map((fact) => `${fact.factType} | ${fact.label}`).join("\n"),
    );
    setScheduledScanEnabled(policy.scheduledScanEnabled);
    setReminderOffsets(policy.reminderBusinessDayOffsets.join(", "));
    setEscalationAfter(String(policy.escalationAfterBusinessDays));
    setEscalationRecipient(policy.escalationRecipientSubject ?? "");
    setQuietStart(policy.quietHoursStartLocal ?? "");
    setQuietEnd(policy.quietHoursEndLocal ?? "");
    setSchedulePreview(null);
  }, [visible, policyQuery.data, policyQuery.isPending, policyQuery.isFetching, policyQuery.isError, draftDirty, draftRevision, policyRevision]);

  const rows = requiredFactsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requiredFacts = rows.map((line) => {
    const separator = line.indexOf("|");
    return separator < 0
      ? { factType: line.trim(), label: "" }
      : { factType: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() };
  });

  async function savePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || operation.current || writeState !== "available" || operationEpoch.current !== renderedOperationEpoch || draftEpoch.current !== renderedDraftEpoch ||
        projectPolicyWrites.snapshot() !== writeVersion || !current() || draftRevision === null || currentRevision() !== draftRevision || !isCurrentScope()) return;
    const write = projectPolicyWrites.begin(writeOwner);
    if (!write) return;
    let confirmed = false;
    operation.current = true; operationEpoch.current++;
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const payload = {
        expectedRevision: draftRevision,
        freshnessWindowSeconds: Number(windowSeconds),
        timeZone: timeZone.trim(),
        requiredFacts,
        responsibleSubject: owner.trim(),
        scheduledScanEnabled,
        reminderBusinessDayOffsets: reminderOffsets.trim()
          ? reminderOffsets.split(/[\s,]+/).map(Number)
          : [],
        escalationAfterBusinessDays: Number(escalationAfter),
        escalationRecipientSubject: Number(escalationAfter) > 0
          ? escalationRecipient.trim()
          : null,
        quietHoursStartLocal: quietStart.trim() || null,
        quietHoursEndLocal: quietEnd.trim() || null,
      };
      const saved = decodePolicy(await request<unknown>(
        `/projects/${projectId}/project-update-policy`,
        { method: "POST", body: JSON.stringify(payload) },
        65_536, undefined, undefined, undefined, 200,
      ), projectId);
      if (!current()) return;
      if (!saved || saved.revision !== draftRevision + 1 || Object.entries(payload).some(([field, value]) =>
        field !== "expectedRevision" && field !== "requiredFacts" && JSON.stringify(saved[field as keyof Policy]) !== JSON.stringify(value)) ||
        saved.requiredFacts.length !== payload.requiredFacts.length || saved.requiredFacts.some((fact, index) =>
          fact.factType !== payload.requiredFacts[index]?.factType || fact.label !== payload.requiredFacts[index]?.label))
        throw new Error("The policy save could not be confirmed. The draft has been retained.");
      const cachedRevision = currentRevision();
      if (!projectPolicyWrites.confirm(writeOwner, write)) throw new Error("The policy save could not be confirmed. The draft has been retained.");
      confirmed = true;
      if (cachedRevision !== draftRevision) {
        void queryClient.invalidateQueries({ queryKey: ["project-update-policy", projectId, admissionScope], exact: true });
        setMessage("The policy save was confirmed, and the current revision needs review before another change.");
        return;
      }
      queryClient.setQueryData(["project-update-policy", projectId, admissionScope], saved);
      setDraftDirty(false);
      setSchedulePreview(null);
      await queryClient.invalidateQueries({
        queryKey: ["project-update-latest", projectId, admissionScope],
      });
      if (!isCurrentScope()) return;
      setMessage("Reporting policy saved as an immutable revision.");
    } catch (error) {
      if (!isCurrentScope()) return;
      setIsError(true);
      setMessage((error as Error).message);
    } finally {
      if (!confirmed) projectPolicyWrites.uncertain(writeOwner, write);
      operation.current = false;
      setBusy(false);
    }
  }

  async function assess() {
    if (busy || operation.current || operationEpoch.current !== renderedOperationEpoch || !current()) return;
    operation.current = true; operationEpoch.current++;
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      await request<Assessment>(
        `/projects/${projectId}/project-update-assessments`,
        { method: "POST", body: "{}" },
      );
      if (!current()) return;
      setSchedulePreview(null);
      await queryClient.invalidateQueries({
        queryKey: ["project-update-latest", projectId, admissionScope],
      });
      if (!isCurrentScope()) return;
      setMessage("Assessment saved. Any request preview remains a draft and has not been sent.");
    } catch (error) {
      if (!isCurrentScope()) return;
      setIsError(true);
      setMessage((error as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function previewSchedule() {
    if (busy || operation.current || operationEpoch.current !== renderedOperationEpoch || !current()) return;
    operation.current = true; operationEpoch.current++;
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const preview = await request<SchedulePreview>(
        `/projects/${projectId}/project-update-schedule-preview`,
      );
      if (!current()) return;
      setSchedulePreview(preview);
      setMessage("Schedule calculated from the current saved assessment. No messages were sent.");
    } catch (error) {
      if (!isCurrentScope()) return;
      setIsError(true);
      setSchedulePreview(null);
      setMessage((error as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  const canPreviewSchedule = Boolean(
    latestQuery.data?.freshness.state === "STALE" &&
    latestQuery.data.obligation?.state === "OPEN" &&
    latestQuery.data.policy.revision === policyQuery.data?.revision,
  );
  const ready = visible && !policyQuery.isPending && !policyQuery.isFetching && !policyQuery.isError &&
    !latestQuery.isPending && !latestQuery.isFetching && !latestQuery.isError;

  return (
    <section className="panel project-updates" aria-label="Project update freshness and completeness">
      {visible && !ready && !policyQuery.error && !latestQuery.error && <p role="status">Checking project update access…</p>}
      {policyQuery.error && <p role="alert" className="error">{policyQuery.error.message}</p>}
      {latestQuery.error && <p role="alert" className="error">{latestQuery.error.message}</p>}
      <div hidden={!ready}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">FRESHNESS & COMPLETENESS</span>
          <h2>Project update</h2>
        </div>
        <Button className="primary" onClick={assess} disabled={busy || !policyQuery.data}>
          Assess project
        </Button>
      </div>
      <p className="muted">
        Source authority controls which facts count. Reported status is shown separately from verified evidence.
        Assessments never write project facts, and request previews are saved as drafts only.
      </p>
      {latestQuery.data && (
        <div className="summary-strip">
          <div><span>Reported status</span><strong>{reportedStatus}</strong></div>
          <div><span>Required facts</span><strong>{latestQuery.data.completeness.confirmedCount}/{latestQuery.data.completeness.requiredCount} confirmed</strong></div>
          <div><span>Freshness</span><strong>{latestQuery.data.freshness.state}</strong></div>
          <div><span>Assessed</span><strong>{new Date(latestQuery.data.assessedAt).toLocaleString()}</strong></div>
        </div>
      )}
      {latestQuery.data && (
        <ul className="audit-list">
          {latestQuery.data.completeness.factAssessments.map((fact) => (
            <li key={fact.factType}>
              <strong>{fact.label}</strong>
              <span>{fact.factType}</span>
              <small>{fact.state}{fact.reasonCodes.length ? ` · ${fact.reasonCodes.join(", ")}` : ""}</small>
            </li>
          ))}
        </ul>
      )}
      {latestQuery.data?.freshness.state === "STALE" && latestQuery.data.obligation && (
        <section className="callout" aria-label="Project update schedule preview">
          <h3>Reminder schedule · Preview only</h3>
          <p>
            Logical due time: {latestQuery.data.obligation.dueAt}.
            Project time zone: {latestQuery.data.policy.timeZone}.
            No messages are sent by this preview.
          </p>
          {canPreviewSchedule ? (
            <Button onClick={previewSchedule} disabled={busy}>
              Preview reminder schedule
            </Button>
          ) : (
            <p>Assess the current reporting policy before previewing its schedule.</p>
          )}
          {schedulePreview && (
            <div>
              <p>
                Assessment {schedulePreview.assessmentId} · policy revision {schedulePreview.policyRevision} ·
                as of {schedulePreview.asOf}. Source time: {schedulePreview.sourceDate}
                ({schedulePreview.sourceTimeBasis}).
              </p>
              <p>
                Logical due: {schedulePreview.logicalDueAt}. First eligible request:
                {schedulePreview.requestEligibleAt} ({schedulePreview.timeZone}).
              </p>
              <ol aria-label="Calculated reminder and escalation stages">
                {schedulePreview.events.map((event, index) => (
                  <li key={event.kind + "-" + index}>
                    <strong>{event.kind}</strong>
                    {event.offsetBusinessDays > 0 ? ` · +${event.offsetBusinessDays} business days` : ""}
                    {" · "}{event.localAt} {schedulePreview.timeZone} (UTC{event.utcOffset})
                    {" · "}{event.scheduledAt} · {event.recipientSubject}
                  </li>
                ))}
              </ol>
              <p>This is a schedule preview only; it has not been sent or queued.</p>
            </div>
          )}
        </section>
      )}
      {latestQuery.data?.knownPosition.length ? (
        <section className="callout" aria-label="Authorized current known position">
          <h3>Authorized current known position</h3>
          <ul>
            {latestQuery.data.knownPosition.map((fact) => (
              <li key={fact.versionId}>
                <strong>{fact.label}</strong>
                <p>{displayFactValue(fact.value)}</p>
                <small>
                  {fact.timestampBasis} · observed {fact.observedAt} · source effective {fact.effectiveAt}
                  · source access revision {fact.sourceAccessRevision}
                  {fact.authorityRevision === null ? "" : ` · authority revision ${fact.authorityRevision}`}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {latestQuery.data?.preview && (
        <div className="callout">
          <h3>Saved request preview · Draft · revision {latestQuery.data.preview.revision}</h3>
          <p>
            Project {latestQuery.data.preview.project.code}: {latestQuery.data.preview.project.name}.
            Reported status: {latestQuery.data.preview.reportedStatus}.
          </p>
          <p>
            Update date: {latestQuery.data.preview.sourceDate} ({latestQuery.data.preview.timestampBasis}).
            Freshness threshold: {latestQuery.data.preview.freshnessThresholdAt}.
            Freshness: {latestQuery.data.preview.freshnessState}; completeness: {latestQuery.data.preview.completenessState}.
          </p>
          <p>Assigned owner: {latestQuery.data.policy.responsibleSubject}. This preview has not been sent.</p>
          <ul aria-label="Requested update information">
            {latestQuery.data.preview.requiredFacts.map((fact) => (
              <li key={fact.factType}>
                {fact.label}: {fact.state}
                {fact.reasonCodes.length ? ` · ${fact.reasonCodes.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pmoAdmin && (
        <details className="canonical-section">
          <summary>Reporting policy · PMO administration</summary>
          <p className="muted">
            Choose the complete required-fact set and a current RESPONSIBLE_OWNER. Leave scheduled scanning off unless the separately configured service identity and signing key are deployed.
          </p>
          <form onSubmit={savePolicy} onChangeCapture={() => { draftEpoch.current++; }}>
            <fieldset disabled={busy}>
            <div className="form-row">
              <TextField
                label="Freshness window (seconds)"
                type="number"
                min={1}
                max={315360000}
                required
                value={windowSeconds}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setWindowSeconds(event.target.value); } }}
              />
              <TextField
                label="Project time zone (IANA)"
                required
                value={timeZone}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setTimeZone(event.target.value); } }}
                placeholder="e.g. Asia/Kolkata"
              />
            </div>
            <TextField
              label="Responsible owner subject"
              required
              maxLength={256}
              value={owner}
              onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setOwner(event.target.value); } }}
              placeholder="Must match the canonical RESPONSIBLE_OWNER"
            />
            <label className="field">
              <span>Required facts (one per line: fact.type | label)</span>
              <textarea
                required
                rows={5}
                maxLength={20000}
                value={requiredFactsText}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setRequiredFactsText(event.target.value); } }}
                placeholder={"project.status | Current status\nproject.forecast_end | Forecast finish"}
              />
            </label>
            <div className="form-row">
              <TextField
                label="Reminder offsets (business days, comma separated)"
                value={reminderOffsets}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setReminderOffsets(event.target.value); } }}
                placeholder="1, 2"
              />
              <TextField
                label="Escalation after (business days; 0 disables)"
                type="number"
                min={0}
                max={90}
                step={1}
                value={escalationAfter}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setEscalationAfter(event.target.value); } }}
              />
            </div>
            <TextField
              label="Escalation recipient subject"
              maxLength={200}
              required={Number(escalationAfter) > 0}
              value={escalationRecipient}
              onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setEscalationRecipient(event.target.value); } }}
              placeholder="Must be a current PROJECT_MANAGER with project access"
            />
            <div className="form-row">
              <TextField
                label="Quiet hours start (project local time)"
                type="time"
                required={Boolean(quietEnd)}
                value={quietStart}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setQuietStart(event.target.value); } }}
              />
              <TextField
                label="Quiet hours end (project local time)"
                type="time"
                required={Boolean(quietStart)}
                value={quietEnd}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setQuietEnd(event.target.value); } }}
              />
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={scheduledScanEnabled}
                onChange={(event) => { if (!busy && !operation.current && isCurrentScope()) { setDraftDirty(true); setScheduledScanEnabled(event.target.checked); } }}
              />
              Enable scheduled assessments for this project
            </label>
            <div className="actions">
              <Button type="submit" className="primary" disabled={busy || rows.length === 0 || draftConflict || draftRevision === null || writeState !== "available"}>
                Save policy revision
              </Button>
            </div>
            {draftConflict && <Message error>The saved reporting policy changed. Review the current revision before saving this draft.</Message>}
            {draftConflict && <Button className="secondary" onClick={() => { if (busy || operation.current || operationEpoch.current !== renderedOperationEpoch || draftEpoch.current !== renderedDraftEpoch || !draftConflict || !current() || currentRevision() !== policyRevision || currentRevision() === draftRevision) return; draftEpoch.current++; setDraftDirty(false); }}>Discard draft and use current policy</Button>}
            {writeState === "pending" && <Message>A policy save is still awaiting confirmation.</Message>}
            {writeState === "uncertain" && <Message error>The earlier policy save could not be confirmed. Another policy save is blocked while this page remains loaded.</Message>}
            {writeState === "capacity" && <Message error>Policy saving is unavailable while earlier outcomes remain unconfirmed.</Message>}
            {writeState === "invalid" && <Message error>Policy saving is unavailable because the project scope could not be established.</Message>}
            {message && <Message error={isError}>{message}</Message>}
            </fieldset>
          </form>
        </details>
      )}
      {!pmoAdmin && message && <Message error={isError}>{message}</Message>}
      {visible && <ProjectUpdateCaptureHistory key={admissionScope} projectId={projectId} request={request} pmoAdmin={pmoAdmin} admissionScope={admissionScope} isCurrentScope={isCurrentScope} />}
      </div>
    </section>
  );
}

function displayFactValue(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value) &&
      "type" in value && value.type === "text" && "value" in value &&
      typeof value.value === "string")
    return value.value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}
