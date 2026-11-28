import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Message } from "./components.js";
import type { RequestFn } from "./canonical-project.js";
import { atlasScheduleMovementText, decodeInvitation, decodeInvitationReceipt } from "./project-update-invitation-decoder.js";
import { CanonicalCreationWriteRegistry, canonicalCommandFingerprint, canonicalCreationOwner } from "./canonical-creation-write-registry.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead } from "./managed-read.js";
import type { CapturedReplyInterpretation, CapturedUpdateFactType, ProjectUpdateCaptureHistory as CaptureHistory, ProjectUpdateRecipientRequestView,
  ProjectUpdateClarificationReceipt, ProjectUpdateFactConfirmation, ProjectUpdateFactConfirmationReceipt,
  ProjectUpdateStatusConfirmationReceipt, ProjectUpdateEscalationContext } from "@pdaa/domain";
import { ConfirmAtlasReply } from "./atlas-update-approval.js";
import "./project-update-response.css";

type ResponseEntry = { id: string; submittedBy: string; receivedAt: string;
  correctsResponseId: string | null; state: "UNCONFIRMED"; contentState: "PRESENT" | "EXPIRED"; text: string | null };
type RecipientRequest = { requestId: string; project: { id: string; code: string; name: string };
  stageKind: string; dueAt: string; capturedAt: string; expiresAt: string; body: string;
  requiredFacts: ProjectUpdateRecipientRequestView["requiredFacts"];
  rawResponseReaders: string[]; responses: ResponseEntry[]; escalationContext?: ProjectUpdateEscalationContext | null;
  atlasInterpretation?: ProjectUpdateRecipientRequestView["atlasInterpretation"];
  clarification?: ProjectUpdateRecipientRequestView["clarification"] };
const invitationReads = new ManagedReadRegistry(8);
const invitationWrites = new CanonicalCreationWriteRegistry();

function EscalationHistory({ context }: { context: ProjectUpdateEscalationContext }) {
  const [expiryVersion, setExpiryVersion] = useState(0);
  const impact = context.impact === "UNKNOWN" ? null : context.impact;
  const impactDeadline = impact?.citation?.availableUntil;
  useEffect(() => {
    const now = Date.now();
    const deadlines = context.entries.filter((entry) => entry.contentState === "PRESENT")
      .map((entry) => Date.parse(entry.contentExpiresAt)).filter((deadline) => deadline > now);
    if (impactDeadline && Date.parse(impactDeadline) > now) deadlines.push(Date.parse(impactDeadline));
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setExpiryVersion((version) => version + 1),
      Math.min(2147483647, Math.max(1, Math.min(...deadlines) - now)));
    return () => window.clearTimeout(timer);
  }, [context, impactDeadline, expiryVersion]);
  const visibleImpact = impact && (!impactDeadline || Date.parse(impactDeadline) > Date.now()) ? impact : null;
  return <section aria-label="Escalation request history">
    <h3>Current-cycle request history</h3>
    <p>Read as of {context.asOf}. Historical request text is not a current confirmed fact.
      Reviewer names are withheld in this history view.</p>
    {!visibleImpact ? <p>Delivery impact is unknown.</p> : <p>
      Saved baseline {visibleImpact.baseline}. Saved forecast {visibleImpact.forecast}.{" "}
      {atlasScheduleMovementText(visibleImpact.movementDays)} Schedule revision {visibleImpact.revision}.
      {visibleImpact.citation && ` Reviewed CSV receipt ${visibleImpact.citation.receiptId}.`}
    </p>}
    {context.state === "UNAVAILABLE" ? <p>Request history is currently unavailable.</p> :
      <ol>{context.entries.map((entry) => {
        const expired = entry.contentState === "EXPIRED" || Date.parse(entry.contentExpiresAt) <= Date.now();
        return <li key={entry.requestId}>
          <strong>{entry.stageKind === "REQUEST" ? "Original recorded request"
            : entry.stageKind === "REMINDER" ? "Recorded reminder" : "Recorded owner escalation"}</strong>
          <p>{entry.capturedAt}</p>
          {entry.contentState === "PRESENT" && !expired && entry.body !== null
            ? <p className="update-plain-text">{entry.body}</p>
            : <p>{expired ? "Request content has expired." : "Request content is restricted."}</p>}
        </li>;
      })}</ol>}
  </section>;
}
type ManualReview = Pick<CaptureHistory["entries"][number], "statusReview" | "forecastReview">;
type ConfirmationItems = ProjectUpdateFactConfirmation["facts"];

function FactConfirmation({ label, receipt }: { label: string; receipt: ProjectUpdateStatusConfirmationReceipt }) {
  return <p>{label} confirmed by {receipt.confirmedBy} at {receipt.confirmedAt}. Receipt {receipt.receiptId}.{" "}
    {receipt.factSatisfied ? "The statement satisfied the requested fact at confirmation."
      : "The statement was recorded for source authority review."}
  </p>;
}

function ManualFactReview({ statusReview, forecastReview, submit, clarify, interpret, current }: ManualReview & {
  submit: (facts: ConfirmationItems) => Promise<unknown>;
  clarify: (factType: CapturedUpdateFactType) => Promise<unknown>; current: () => boolean;
  interpret?: () => Promise<CapturedReplyInterpretation>;
}) {
  const [status, setStatus] = useState(() => statusReview?.state === "PENDING" ? statusReview.suggestedValue ?? "" : "");
  const [forecast, setForecast] = useState(() => forecastReview?.state === "PENDING" ? forecastReview.suggestedValue ?? "" : "");
  const pendingStatus = statusReview?.state === "PENDING" ? statusReview : null;
  const pendingForecast = forecastReview?.state === "PENDING" ? forecastReview : null;
  const validStatus = status.trim().length > 0 && new TextEncoder().encode(status).length <= 500 &&
    !/[\p{Cc}\p{Surrogate}]/u.test(status);
  const validForecast = /^\d{4}-\d{2}-\d{2}$/u.test(forecast) && !forecast.startsWith("0000-");
  const facts: ConfirmationItems = [];
  if (pendingStatus && validStatus)
    facts.push({ factType: "project.status", expectedRevision: pendingStatus.expectedRevision, value: status });
  if (pendingForecast && validForecast)
    facts.push({ factType: "project.forecast", expectedRevision: pendingForecast.expectedRevision, value: forecast });
  const valid = facts.length > 0 && (!pendingStatus || !status.trim() || validStatus) &&
    (!pendingForecast || !forecast || validForecast);
  const confirmation = useMutation({
    mutationFn: async () => {
      if (!current() || !valid) throw new Error("Manual review unavailable");
      await submit(facts);
    },
  });
  const clarification = useMutation({
    mutationFn: async (factType: CapturedUpdateFactType) => {
      const review = factType === "project.status" ? pendingStatus : pendingForecast;
      if (!current() || !review) throw new Error("Manual review unavailable");
      await clarify(factType);
    },
  });
  const interpretation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      if (!interpret || !current()) throw new Error("Reply interpretation unavailable");
      return interpret();
    },
  });
  const interpreted = interpret && current() ? interpretation.data : undefined;
  const busy = confirmation.isPending || clarification.isPending || interpretation.isPending;
  return <section aria-label="Manual project update review">
    {statusReview?.state === "CONFIRMED" && <FactConfirmation label="Project status" receipt={statusReview} />}
    {forecastReview?.state === "CONFIRMED" && <FactConfirmation label="Project forecast" receipt={forecastReview} />}
    {statusReview?.state === "CLARIFICATION_REQUESTED" &&
      <p>Status clarification requested at {statusReview.requestedAt}. Awaiting an updated response from the owner.</p>}
    {forecastReview?.state === "CLARIFICATION_REQUESTED" &&
      <p>Forecast clarification requested at {forecastReview.requestedAt}. Awaiting an updated response from the owner.</p>}
    {(pendingStatus?.suggestedValue || pendingForecast?.suggestedValue) &&
      <p>Values from the reply are suggestions. Review or edit them before confirming.</p>}
    {interpret && (pendingStatus || pendingForecast) && <Button disabled={busy || !current()}
      onClick={() => interpretation.mutate()}>Interpret reply</Button>}
    {interpret && interpretation.isPending && <Message>Checking the reply for grounded suggestions…</Message>}
    {interpret && (interpretation.isError || interpreted?.suggestions.length === 0) && current() &&
      <Message>Enter the confirmed values after reviewing the reply.</Message>}
    {interpreted?.suggestions.map(({ factType, value }) => {
      const status = factType === "project.status";
      if (status ? !pendingStatus : !pendingForecast) return null;
      return <div key={factType}>
        <p>Agent inference for {status ? "status" : "forecast"}. {value}</p>
        <Button disabled={busy || !current()} onClick={() => {
          if (current()) (status ? setStatus : setForecast)(value);
        }}>Use {status ? "status" : "forecast"} suggestion</Button>
      </div>;
    })}
    {pendingStatus && <label className="field"><span>Confirmed project status</span>
      <input type="text" value={status} maxLength={500} onChange={(event) => setStatus(event.currentTarget.value)}
        disabled={busy} />
    </label>}
    {pendingForecast && <label className="field"><span>Confirmed project forecast date</span>
      <input type="date" value={forecast} onChange={(event) => setForecast(event.currentTarget.value)} disabled={busy} />
    </label>}
    {(pendingStatus || pendingForecast) && <Button className="primary" disabled={!valid || busy || !current()}
      onClick={() => confirmation.mutate()}>
      {pendingStatus && pendingForecast ? "Confirm entered facts" : pendingStatus ? "Confirm project status" : "Confirm project forecast"}
    </Button>}
    {pendingStatus && <Button disabled={busy || !current()} onClick={() => clarification.mutate("project.status")}>
      {pendingForecast ? "Request status clarification" : "Request clarification"}
    </Button>}
    {pendingForecast && <Button disabled={busy || !current()} onClick={() => clarification.mutate("project.forecast")}>
      {pendingStatus ? "Request forecast clarification" : "Request clarification"}
    </Button>}
    {confirmation.isError && <Message error>Could not verify the confirmation. Check the current response and try again.</Message>}
    {clarification.isError && <Message error>Could not verify the clarification request. Check the current response and try again.</Message>}
  </section>;
}

function Responses({ entries }: { entries: ResponseEntry[] }) {
  return <ul>{entries.map((entry) => <li key={entry.id}>
    <strong>Unconfirmed response</strong> · {entry.submittedBy} · {entry.receivedAt}
    {entry.correctsResponseId && <p>Correction to an earlier response; both are retained.</p>}
    <p className="update-plain-text">{entry.text ?? "Response content has expired."}</p>
  </li>)}</ul>;
}

export function ProjectUpdateResponse({ locator, customerId, subject, ownerScope, admissionScope, request, isCurrentScope, atlasDemo }: {
  locator: string; customerId: string; subject: string; ownerScope: string; admissionScope: string; request: RequestFn; isCurrentScope: () => boolean; atlasDemo?: boolean;
}) {
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false), [denied, setDenied] = useState(false), [attempt, setAttempt] = useState(0);
  const active = useRef(true), lifecycle = useRef(0), expiredRef = useRef(false), deniedRef = useRef(false), attemptRef = useRef(0), issuance = useRef(0);
  const deadline = useRef<number | null>(null), [deadlineRevision, setDeadlineRevision] = useState(0);
  const ownerKey = ["project-update-invitation", locator, ownerScope] as const;
  const key = ["project-update-invitation", locator, ownerScope, admissionScope, attempt] as const;
  const query = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    if (!isCurrentScope() || !active.current || expiredRef.current || (deadline.current !== null && Date.now() >= deadline.current) || deniedRef.current || attemptRef.current !== attempt)
      throw new Error("Request is unavailable.");
    const read = ++issuance.current, owner = lifecycle.current;
    const current = () => isCurrentScope() && active.current && !expiredRef.current && (deadline.current === null || Date.now() < deadline.current) && !deniedRef.current &&
      attemptRef.current === attempt && issuance.current === read && lifecycle.current === owner;
    const raw = await managedRead(invitationReads, signal, current, (live, completion) =>
      request<unknown>(`/project-update-invitations/${locator}`, { redirect: "error" }, 8 * 1024 * 1024, (unavailable) => {
        if (!unavailable || !live()) return;
        deniedRef.current = true; setDenied(true);
        queryClient.removeQueries({ queryKey: ownerKey });
      }, { current: live, completion }, live, 200));
    const value = decodeInvitation(raw);
    if (!current() || !value) throw new Error("Request is unavailable.");
    const receivedDeadline = Date.parse(value.expiresAt);
    if (deadline.current === null || receivedDeadline < deadline.current) {
      deadline.current = receivedDeadline; setDeadlineRevision((revision) => revision + 1);
    }
    if (deadline.current <= Date.now()) throw new Error("Request is unavailable.");
    return { issuance: read, lifecycle: owner, value: value as RecipientRequest };
  }, enabled: isCurrentScope() && !expired && !denied, retry: false, staleTime: 0, refetchOnWindowFocus: true });
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const operation = useRef(false), operationEpoch = useRef(0), draftEpoch = useRef(0);
  const submission = useRef<{ key: string; text: string; correction: string | null; payload: string; fingerprint?: string } | null>(null);
  const writeOwner = canonicalCreationOwner(customerId, locator);
  const writeVersion = useSyncExternalStore(invitationWrites.subscribe, invitationWrites.snapshot, invitationWrites.snapshot);
  const renderedDraftEpoch = draftEpoch.current, renderedOperationEpoch = operationEpoch.current;
  const command = submission.current;
  const writeState = invitationWrites.state(writeOwner, command?.fingerprint && command.text === text && command.correction === correction
    ? { key: command.key, fingerprint: command.fingerprint } : null);
  const rendered = query.data;
  const currentInvitation = () => {
    const state = queryClient.getQueryState<{ issuance: number; lifecycle: number; value: RecipientRequest }>(key);
    return Boolean(isCurrentScope() && active.current && !expiredRef.current && !deniedRef.current && rendered &&
      issuance.current === rendered.issuance && lifecycle.current === rendered.lifecycle && state?.data === rendered && state.status === "success" && state.fetchStatus === "idle" &&
      deadline.current !== null && Date.now() < deadline.current && Date.now() < Date.parse(rendered.value.expiresAt));
  };
  const retryIssuance = issuance.current, retryLifecycle = lifecycle.current;
  const retry = () => {
    const sameError = query.isError && !deniedRef.current && queryClient.getQueryState(key)?.status === "error";
    if (!isCurrentScope() || !active.current || expiredRef.current || (deadline.current !== null && Date.now() >= deadline.current) ||
        attemptRef.current !== attempt || issuance.current !== retryIssuance || lifecycle.current !== retryLifecycle ||
        !(denied && deniedRef.current) && !sameError) return;
    deniedRef.current = false; setDenied(false); attemptRef.current++; setAttempt(attemptRef.current);
  };
  useEffect(() => { active.current = true;
    // StrictMode effect replay invalidates the previous read without proving
    // its original finished. Give the replacement its own query attempt.
    if (lifecycle.current > 0) { attemptRef.current++; setAttempt(attemptRef.current); }
    return () => {
    active.current = false; lifecycle.current++; submission.current = null;
    queryClient.removeQueries({ queryKey: ownerKey });
  }; }, [queryClient, locator, ownerScope]);
  useEffect(() => {
    if (deadline.current === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (!active.current || deadline.current === null) return;
      const remaining = deadline.current - Date.now();
      if (remaining <= 0) {
        expiredRef.current = true; setExpired(true); draftEpoch.current++; setText(""); setCorrection(null); submission.current = null;
        queryClient.removeQueries({ queryKey: ownerKey }); return;
      }
      timer = setTimeout(check, Math.min(2147483647, Math.max(1, remaining)));
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    check(); window.addEventListener("focus", check); document.addEventListener("visibilitychange", onVisible);
    return () => { if (timer !== undefined) clearTimeout(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", onVisible); };
  }, [deadlineRevision, queryClient, locator, ownerScope]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (operation.current || busy || operationEpoch.current !== renderedOperationEpoch || draftEpoch.current !== renderedDraftEpoch ||
        invitationWrites.snapshot() !== writeVersion ||
        !currentInvitation() || !rendered || !text.trim() || new TextEncoder().encode(text).length > 16384) return;
    if (writeState !== "available" && writeState !== "retryable") {
      setFailed(true); setMessage("An earlier response could not be confirmed. Retry the same response or check its history."); return;
    }
    const snapshotEpoch = draftEpoch.current, snapshotText = text, snapshotCorrection = correction, requestId = rendered.value.requestId;
    let prepared = submission.current;
    if (!prepared || prepared.text !== snapshotText || prepared.correction !== snapshotCorrection) {
      if (invitationWrites.state(writeOwner, null) !== "available") { setFailed(true); setMessage("An earlier response could not be confirmed. Retry the same response or check its history."); return; }
      const idempotencyKey = crypto.randomUUID();
      prepared = { key: idempotencyKey, text: snapshotText, correction: snapshotCorrection,
        payload: JSON.stringify({ text: snapshotText, idempotencyKey, correctsResponseId: snapshotCorrection }) };
      submission.current = prepared;
    }
    const pending = prepared;
    operation.current = true; operationEpoch.current++; setBusy(true); setMessage(""); setFailed(false);
    let lease: symbol | null = null;
    try {
      pending.fingerprint = await canonicalCommandFingerprint(subject, pending.payload);
      if (!currentInvitation() || draftEpoch.current !== snapshotEpoch || invitationWrites.snapshot() !== writeVersion) {
        if (isCurrentScope() && active.current) { setFailed(true); setMessage("Response activity changed. Review your update and try again."); }
        return;
      }
      lease = invitationWrites.begin(writeOwner, { key: pending.key, fingerprint: pending.fingerprint });
      if (!lease) { setFailed(true); setMessage("An earlier response could not be confirmed. Retry the same response or check its history."); return; }
      const raw = await request<unknown>(`/project-update-invitations/${locator}/responses`, { method: "POST", body: pending.payload },
        1024 * 1024, (unavailable) => {
          if (!unavailable || !currentInvitation()) return;
          deniedRef.current = true; setDenied(true); queryClient.removeQueries({ queryKey: ownerKey });
        }, undefined, currentInvitation, 201);
      if (!decodeInvitationReceipt(raw, requestId)) throw new Error("Response receipt unavailable.");
      invitationWrites.confirm(writeOwner, lease); lease = null;
      if (!currentInvitation() || draftEpoch.current !== snapshotEpoch) return;
      setText(""); setCorrection(null); submission.current = null;
      setMessage("Response recorded; required facts remain unconfirmed.");
      void queryClient.invalidateQueries({ queryKey: key, exact: true }).catch(() => {
        if (isCurrentScope() && active.current) setMessage("Response recorded; the request could not be refreshed.");
      });
    } catch {
      if (lease) invitationWrites.uncertain(writeOwner, lease);
      if (!isCurrentScope() || !active.current || draftEpoch.current !== snapshotEpoch) return;
      setFailed(true);
      setMessage("Your response could not be confirmed. Retry the same response or check its history.");
    } finally { operation.current = false; if (active.current) setBusy(false); }
  }

  if (expired || (deadline.current !== null && Date.now() >= deadline.current) ||
      (rendered && Date.now() >= Date.parse(rendered.value.expiresAt))) return <Message error>This update request is unavailable or has expired.</Message>;
  if (denied || query.isError) return <div>{message && !failed && <Message>{message}</Message>}
    {(writeState === "pending" || writeState === "uncertain" || writeState === "retryable") &&
      <p>A previously sent response may still be unconfirmed.</p>}
    <Message error>This update request is unavailable or has expired.</Message>
    <Button className="secondary" onClick={retry}>Check request access</Button></div>;
  if (!rendered || !currentInvitation()) return <Message>Loading update request…</Message>;
  const invitation = rendered.value;
  const interpretation = invitation.atlasInterpretation;
  const asksForStatus = invitation.requiredFacts.some(({ factType }) => factType === "project.status");
  const asksForForecast = invitation.requiredFacts.some(({ factType }) => factType === "project.forecast");
  const visibleExpiry = deadline.current !== null && deadline.current < Date.parse(invitation.expiresAt)
    ? new Date(deadline.current).toISOString() : invitation.expiresAt;
  return <section className="panel" aria-label="Respond to update request">
    <h2>{invitation.project.name}: update requested</h2>
    <p className="update-plain-text">{invitation.body}</p>
    {invitation.escalationContext && <EscalationHistory context={invitation.escalationContext} />}
    <p>Available until {visibleExpiry}. Raw responses are shared with: {invitation.rawResponseReaders.join(", ")}.</p>
    <Responses entries={invitation.responses} />
    {invitation.clarification && <section aria-label="Clarification requested">
      <h3>Clarification requested</h3>
      <p>{invitation.clarification.question}</p>
    </section>}
    {atlasDemo && interpretation &&
      <ConfirmAtlasReply key={interpretation.responseId} locator={locator} responseId={interpretation.responseId}
        suggestion={interpretation.suggestedStatus === "NEEDS_CLARIFICATION" ? null : interpretation.suggestedStatus}
        request={request} isCurrent={currentInvitation} />}
    <form onSubmit={submit}>
      <label className="field"><span>Your update (unconfirmed)</span>
        <textarea required maxLength={8000} rows={6} value={text} disabled={busy}
          onChange={(event) => { if (currentInvitation()) { draftEpoch.current++; setText(event.target.value); } }} aria-describedby="update-response-notice" />
      </label>
      <p id="update-response-notice">Submitting records your response. Required facts remain unconfirmed, reminders continue, and no Jira change is made.</p>
      {(asksForStatus || asksForForecast) && <p>
        {asksForStatus && <>To suggest a status for review, start a line with <code>Status:</code>. </>}
        {asksForForecast && <>To suggest a date, put <code>Forecast: YYYY-MM-DD</code> on its own line.</>}
      </p>}
      <label className="field"><span>Correct an earlier response (optional)</span>
        <select value={correction ?? ""} disabled={busy} onChange={(event) => { if (currentInvitation()) { draftEpoch.current++; setCorrection(event.target.value || null); } }}>
          <option value="">New response</option>
          {invitation.responses.map((entry) => <option key={entry.id} value={entry.id}>{entry.receivedAt}</option>)}
        </select>
      </label>
      <Button className="primary" type="submit" disabled={busy || !text.trim() || new TextEncoder().encode(text).length > 16384}>Record response</Button>
      {writeState === "pending" && <p>A response is being recorded. Wait for its result before sending another.</p>}
      {(writeState === "uncertain" || writeState === "retryable") && <p>An earlier response could not be confirmed; it may already have been recorded.</p>}
      {(writeState === "capacity" || writeState === "invalid") && <p>A response cannot be started right now. Check access or try again later.</p>}
      {message && <Message error={failed}>{message}</Message>}
    </form>
  </section>;
}

export function ProjectUpdateCaptureHistory({ projectId, request, pmoAdmin, admissionScope, isCurrentScope }: { projectId: string; request: RequestFn; pmoAdmin: boolean; admissionScope: string; isCurrentScope: () => boolean }) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const query = useQuery({ queryKey: ["project-update-capture-history", projectId, admissionScope, cursor], retry: false,
    // Keep the original response owned through completion when the logical
    // project view closes; unmount is not evidence of remote cancellation.
    queryFn: () => request<CaptureHistory>(`/projects/${projectId}/project-update-capture-history${cursor ? "?cursor=" + cursor : ""}`) });
  const data = query.isError ? undefined : query.data;
  const current = () => {
    const state = queryClient.getQueryState<CaptureHistory>(["project-update-capture-history", projectId, admissionScope, cursor]);
    return isCurrentScope() && state?.status === "success" && state.fetchStatus === "idle" && state.data === data;
  };
  const canApprove = data?.engagement?.mode === "SHADOW" ||
    (data?.entries.some((entry) => entry.status === "QUARANTINED") &&
      !data.entries.some((entry) => entry.status === "ACTIVE"));
  async function approveCapture() {
    if (!data?.engagement || busy || !current()) return;
    setBusy(true); setMessage("");
    try {
      await request(`/projects/${projectId}/project-update-capture-generations`, { method: "POST",
        body: JSON.stringify({ expectedPolicyRevision: data.engagement.policyRevision,
          expectedEngagementGeneration: data.engagement.generation }) });
      if (!current()) return;
      setMessage("Capture generation approved. Requests will be prepared after current access and evidence checks.");
      await queryClient.invalidateQueries({ queryKey: ["project-update-capture-history", projectId, admissionScope] });
    } catch { if (current()) setMessage("Capture could not be approved. Refresh the policy and capture history before retrying."); }
    finally { setBusy(false); }
  }
  async function confirmFacts(requestId: string, responseId: string, facts: ConfirmationItems) {
    try {
      const receipts = await request<ProjectUpdateFactConfirmationReceipt>(`/projects/${projectId}/project-update-fact-confirmations`, {
        method: "POST", body: JSON.stringify({ requestId, responseId, facts }),
      }, 4096, undefined, undefined, current);
      if (receipts.length !== facts.length || receipts.some((receipt, index) =>
        receipt.responseId !== responseId || receipt.factType !== facts[index]?.factType))
        throw new Error("Manual confirmation receipt mismatch");
    } finally {
      if (isCurrentScope())
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["project-update-capture-history", projectId, admissionScope] }),
          queryClient.invalidateQueries({ queryKey: ["project-update-latest", projectId, admissionScope] }),
        ]);
    }
  }
  async function requestClarification(requestId: string, responseId: string, factType: CapturedUpdateFactType) {
    try {
      const receipt = await request<ProjectUpdateClarificationReceipt>(`/projects/${projectId}/project-update-status-clarifications`, {
        method: "POST", body: JSON.stringify({ requestId, responseId, factType }),
      }, 4096, undefined, undefined, current);
      if (receipt.responseId !== responseId) throw new Error("Clarification receipt mismatch");
    } finally {
      if (isCurrentScope())
        await queryClient.invalidateQueries({ queryKey: ["project-update-capture-history", projectId, admissionScope] });
    }
  }
  async function interpretReply(requestId: string, responseId: string) {
    const result = await request<CapturedReplyInterpretation>(`/projects/${projectId}/project-update-reply-interpretations`, {
      method: "POST", body: JSON.stringify({ requestId, responseId }),
    }, 4096, undefined, undefined, current, 200);
    if (!current() || result?.requestId !== requestId || result.responseId !== responseId ||
        result.classification !== "AGENT_INFERENCE" || !Array.isArray(result.suggestions) || result.suggestions.length > 2 ||
        result.suggestions.some((item) => !item || typeof item.value !== "string" ||
          (item.factType !== "project.status" && item.factType !== "project.forecast")))
      throw new Error("Reply interpretation unavailable");
    return result;
  }
  return <section className="panel" aria-label="Captured update requests">
    <h3>Captured update requests</h3>
    <p>Requests and unconfirmed responses are retained according to the customer’s content policy.</p>
    {query.isError ? <Message error>Capture history is unavailable for this account.</Message> :
      !data ? <Message>Loading capture history…</Message> : <>
        {data.entries.length === 0 && <p>No captured requests on this page.</p>}
        {data.entries.map(({ statusReview, forecastReview, ...entry }) => {
          const responseId = (statusReview ?? forecastReview)?.responseId;
          const statusRevision = statusReview?.state === "PENDING" ? statusReview.expectedRevision : null;
          const forecastRevision = forecastReview?.state === "PENDING" ? forecastReview.expectedRevision : null;
          const reviewKey = JSON.stringify([responseId, statusRevision, forecastRevision]);
          return <article key={entry.requestId}>
            <h4>{entry.stageKind} · {entry.recipientSubject} · {entry.status}</h4>
            {entry.status === "QUARANTINED" && <p>This invitation has been invalidated. Retained content is available to authorized readers.</p>}
            <p>Captured {entry.capturedAt} · Invitation expires {entry.expiresAt}</p>
            <p className="update-plain-text">{entry.body ?? (entry.contentState === "EXPIRED" ? "Request content has expired." : "Content is restricted for this account.")}</p>
            {entry.recipientPath && <a href={entry.recipientPath}>Respond to this request</a>}
            <Responses entries={entry.responses} />
            {pmoAdmin && responseId && <ManualFactReview key={reviewKey} statusReview={statusReview} forecastReview={forecastReview}
              current={current} clarify={(factType) => requestClarification(entry.requestId, responseId, factType)}
              submit={(facts) => confirmFacts(entry.requestId, responseId, facts)}
              {...(entry.interpretationAvailable && { interpret: () => interpretReply(entry.requestId, responseId) })} />}
          </article>;
        })}
        <div className="actions">
          {cursor && <Button onClick={() => { if (current()) setCursor(null); }}>Newest requests</Button>}
          {data.nextCursor && <Button onClick={() => { if (current()) setCursor(data.nextCursor); }}>Older requests</Button>}
          {pmoAdmin && canApprove && <Button disabled={busy} onClick={approveCapture}>Approve a new capture generation</Button>}
        </div>
      </>}
    {message && <Message>{message}</Message>}
  </section>;
}
