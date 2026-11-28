import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AtlasLeadershipAnswer as Answer, AtlasLeadershipFacts } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { atlasScheduleMovementText, decodeAtlasDelayClarification, decodeAtlasLeadershipAnswer } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";
import { AtlasManagementSnapshot } from "./atlas-management-snapshot.js";
import { delayClarificationQuestion } from "./project-delay-clarification.js";

const snapshotIdFormat = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function AtlasSnapshotChanges({ current, prior }: { current: AtlasLeadershipFacts; prior: NonNullable<Answer["priorSnapshot"]> }) {
  const previous = prior.facts;
  const access = (facts: AtlasLeadershipFacts) => facts.ownerReply?.accessStatus === "ACCESS_PENDING" ? "Pending"
    : facts.ownerReply?.accessStatus === "ACCESS_RESTORED" ? "Restored" : "Unavailable";
  const action = (facts: AtlasLeadershipFacts) => facts.receipt ? `Fixture revision ${facts.receipt.fixtureRevision}` : "Unavailable";
  const cause = (facts: AtlasLeadershipFacts) => facts.delayAssessment ? "API access delay" : "Unknown";
  const confidence = (facts: AtlasLeadershipFacts) => facts.delayAssessment?.confidence.toLowerCase() ?? "unknown";
  const changes = [
    ["Baseline date", previous.schedule?.baseline, current.schedule?.baseline],
    ["Forecast date", previous.schedule?.forecast, current.schedule?.forecast],
    ["Owner-confirmed API access", access(previous), access(current)],
    ["Simulated Jira action", action(previous), action(current)],
    ["PM-confirmed cause", cause(previous), cause(current)],
    ["PM forecast confidence", confidence(previous), confidence(current)],
  ].filter(([, before, after]) => (before ?? null) !== (after ?? null));
  return <section aria-label="Changes since the saved snapshot">
    <h3>Changes since the saved snapshot</h3>
    <p>Prior snapshot {prior.id} at {previous.asOf}. Current evidence checked at {current.asOf}.</p>
    {changes.length ? <table>
      <thead><tr><th scope="col">Fact</th><th scope="col">Saved snapshot</th><th scope="col">Current</th></tr></thead>
      <tbody>{changes.map(([label, before, after]) => <tr key={label}>
        <th scope="row">{label}</th><td>{before ?? "Unavailable"}</td><td>{after ?? "Unavailable"}</td>
      </tr>)}</tbody>
    </table> : <p>No changes to the compared fields.</p>}
    <p>Prior evidence includes schedule revision {previous.schedule?.revision}, owner reply {previous.ownerReply?.responseId}
      {" "}and comment receipt {previous.receipt?.id}{previous.delayAssessment ? `, with PM assessment ${previous.delayAssessment.id}` : ""}.</p>
  </section>;
}

export function AtlasLeadershipAnswer({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [asked, setAsked] = useState(false);
  const [snapshotInput, setSnapshotInput] = useState("");
  const [priorSnapshotId, setPriorSnapshotId] = useState<string | null>(null);
  const candidateSnapshotId = snapshotInput.trim().toLowerCase();
  const query = useQuery({
    queryKey: ["atlas-leadership-answer", projectId, scope, priorSnapshotId],
    enabled: asked && isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const comparison = priorSnapshotId ? `?priorSnapshotId=${encodeURIComponent(priorSnapshotId)}` : "";
      const data = decodeAtlasLeadershipAnswer(await request(`/projects/${projectId}/atlas-leadership-answer${comparison}`, undefined, 16384), projectId);
      if (!data || (data.priorSnapshot?.id ?? null) !== priorSnapshotId) throw new Error("Atlas leadership answer unavailable");
      return data;
    },
  });
  const refresh = query.refetch;
  const answer = asked && isCurrent() && query.isSuccess && !query.isFetching ? query.data : null;
  const now = Date.now();
  const expiry = [answer?.ownerReply?.availableUntil, answer?.pmEscalation?.availableUntil,
    answer?.priorSnapshot?.facts.ownerReply?.availableUntil, answer?.updateFreshness?.activeClarification?.availableUntil,
    answer?.scheduleCitation?.availableUntil, answer?.priorSnapshot?.facts.scheduleCitation?.availableUntil,
    answer?.jiraBlocker?.claim.validUntil]
    .filter((date): date is string => Boolean(date && Date.parse(date) > now)).sort()[0];
  useEffect(() => {
    if (!expiry) return;
    const delay = Date.parse(expiry) - Date.now();
    if (delay <= 0) { void refresh(); return; }
    const timer = window.setTimeout(() => void refresh(), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiry, refresh]);
  const reply = answer?.ownerReply && Date.parse(answer.ownerReply.availableUntil) > Date.now() ? answer.ownerReply : null;
  const receipt = reply ? answer?.receipt : null;
  const spreadsheet = answer?.scheduleCitation;
  const schedule = !spreadsheet || Date.parse(spreadsheet.availableUntil) > Date.now() ? answer?.schedule : null;
  const assessment = receipt && schedule ? answer?.delayAssessment : null;
  const integration = answer?.integrationStart;
  const candidateBlocker = answer?.jiraBlocker;
  const blocker = candidateBlocker && (candidateBlocker.claim.validUntil === null ||
    Date.parse(candidateBlocker.claim.validUntil) > Date.now()) ? candidateBlocker : null;
  const freshness = answer?.updateFreshness;
  const updateClaim = answer?.updateClaim;
  const pending = freshness?.activeClarification;
  const clarification = pending && Date.parse(pending.availableUntil) > Date.now() ? pending : null;
  const escalation = reply && answer?.pmEscalation && Date.parse(answer.pmEscalation.availableUntil) > Date.now()
    ? answer.pmEscalation : null;
  const detailClaims = answer?.detailClaims;
  const replyClaim = reply && detailClaims?.find(({ kind }) => kind === "OWNER_ACCESS");
  const commentClaim = receipt && detailClaims?.find(({ kind }) => kind === "PM_COMMENT");
  const escalationClaim = escalation && detailClaims?.find(({ kind }) => kind === "PM_ESCALATION");
  const clarificationClaim = clarification && detailClaims?.find(({ kind }) => kind === "UPDATE_CLARIFICATION");
  const integrationClaim = integration && detailClaims?.find(({ kind }) => kind === "INTEGRATION_START");
  const forecastClaim = schedule && integrationClaim && blocker && detailClaims?.find(({ kind }) => kind === "FORECAST_INFERENCE");
  const prior = answer?.priorSnapshot;
  const scheduleRef = `atlas-schedule-${projectId}`;
  const freshnessRef = `atlas-update-freshness-${updateClaim?.evidenceIds[0]}`;
  const integrationRef = `atlas-integration-${projectId}`;
  const blockerRef = `atlas-blocker-${projectId}`;
  const escalationRef = `atlas-pm-escalation-${projectId}`;
  const replyRef = `atlas-reply-${projectId}`;
  const receiptRef = `atlas-receipt-${projectId}`;
  const assessmentRef = `atlas-delay-assessment-${projectId}`;
  const days = schedule?.movementDays ?? null;
  const askPm = useMutation({
    mutationFn: async ({ scheduleRevision }: { scheduleRevision: number; scope: string; asOf: string }) => {
      if (!isCurrent()) throw new Error("Atlas project access changed");
      const raw = await request(`/projects/${projectId}/atlas-delay-clarification`, {
        method: "POST", body: JSON.stringify({ scheduleRevision }),
      }, 4096, undefined, undefined, isCurrent);
      const result = decodeAtlasDelayClarification(raw);
      if (result?.schedule.revision !== scheduleRevision) throw new Error("Atlas clarification could not be verified");
      return result;
    },
  });
  const currentClarification = askPm.variables?.scope === scope && askPm.variables.scheduleRevision === schedule?.revision &&
    askPm.variables.asOf === answer?.asOf;
  const askedPmForSchedule = currentClarification && askPm.isSuccess;
  const movementClaim = schedule && (answer?.receiptClaims?.find(({ kind }) => kind === "REVIEWED_SCHEDULE") ??
    detailClaims?.find(({ kind }) => kind === "CANONICAL_SCHEDULE"));
  const scheduleReceipt = schedule && !spreadsheet ? answer?.canonicalCreationReceiptId : undefined;
  const hasScheduleEvidence = Boolean(movementClaim || scheduleReceipt);
  const pmClaim = assessment && answer?.receiptClaims?.find(({ kind }) => kind === "PM_DELAY_ASSESSMENT");

  return <><section className="panel" aria-label="Atlas leadership answer">
    <h2>Atlas delivery question</h2>
    <Button className="secondary" disabled={query.isFetching || !isCurrent()} onClick={() => {
      if (asked && !priorSnapshotId) void refresh();
      else { setAsked(true); setPriorSnapshotId(null); }
    }}>Why is Atlas delayed?</Button>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!isCurrent() || query.isFetching || !snapshotIdFormat.test(candidateSnapshotId)) return;
      if (priorSnapshotId === candidateSnapshotId) void refresh();
      else { setAsked(true); setPriorSnapshotId(candidateSnapshotId); }
    }}>
      <label className="field"><span>Saved snapshot ID</span>
        <input value={snapshotInput} maxLength={36} onChange={(event) => setSnapshotInput(event.currentTarget.value)} />
      </label>
      <Button className="secondary" type="submit"
        disabled={!snapshotIdFormat.test(candidateSnapshotId) || query.isFetching || !isCurrent()}>Compare with current facts</Button>
    </form>
    {asked && query.isFetching && <p role="status">Checking Atlas evidence…</p>}
    {asked && query.isError && <Message error>The Atlas answer is unavailable.</Message>}
    {answer && <div aria-live="polite">
      <p>{movementClaim?.claimText ?? atlasScheduleMovementText(null)}
        {hasScheduleEvidence && <> <a href={`#${scheduleRef}`}>Schedule evidence</a></>}</p>
      {updateClaim && <p>{updateClaim.claimText}{" "}
        {clarificationClaim && `${clarificationClaim.claimText} `}
        <a href={`#${freshnessRef}`}>Update freshness evidence</a></p>}
      {integrationClaim && <p>{integrationClaim.claimText} <a href={`#${integrationRef}`}>Integration start evidence</a></p>}
      {blocker && <p>{blocker.claim.claimText} <a href={`#${blockerRef}`}>Jira blocker evidence</a></p>}
      {forecastClaim && <p><strong>Agent inference.</strong> {forecastClaim.claimText}
        {" "}<a href={`#${scheduleRef}`}>Schedule</a> · <a href={`#${integrationRef}`}>Integration start</a> · <a href={`#${blockerRef}`}>Open blocker</a>
      </p>}
      {replyClaim && <p>{replyClaim.claimText}{" "}
        <a href={`#${replyRef}`}>Reply evidence</a></p>}
      {commentClaim && <p>{commentClaim.claimText}{" "}
        <a href={`#${receiptRef}`}>Receipt evidence</a></p>}
      {escalationClaim
        ? <p>{escalationClaim.claimText} <a href={`#${escalationRef}`}>PM escalation evidence</a></p>
        : <p>PM escalation evidence is unavailable.</p>}
      {(!reply || !receipt) && <p>Some reply or action evidence is unavailable for this answer.</p>}
      {pmClaim
        ? <p>{pmClaim.claimText}{" "}
          <a href={`#${assessmentRef}`}>PM assessment evidence</a></p>
        : <p>The verified cause of the schedule change and confidence in the forecast remain unknown.</p>}
      {!assessment && schedule && days !== null && days > 0 && <details>
        <summary>Draft a question for the assigned PM</summary>
        <p>{delayClarificationQuestion(schedule)}</p>
        {(askedPmForSchedule || answer.delayClarificationState === "REQUESTED") &&
          <Message>Clarification added to the assigned PM’s Atlas project panel.</Message>}
        {!askedPmForSchedule && answer.delayClarificationState === "AVAILABLE" &&
          <Button className="secondary" disabled={askPm.isPending || !isCurrent()}
            onClick={() => askPm.mutate({ scheduleRevision: schedule.revision, scope, asOf: answer.asOf })}>Ask the assigned PM</Button>}
        {answer.delayClarificationState === "RESOLVED" && <p>The request for this schedule has been answered.</p>}
        {askPm.isError && currentClarification && <Message error>Could not request clarification. Refresh the answer and try again.</Message>}
      </details>}
      {prior?.facts.ownerReply && Date.parse(prior.facts.ownerReply.availableUntil) > Date.now() &&
        (!prior.facts.scheduleCitation || Date.parse(prior.facts.scheduleCitation.availableUntil) > Date.now()) &&
        <AtlasSnapshotChanges current={{ ...answer, schedule: schedule ?? null, ownerReply: reply, receipt: receipt ?? null,
          delayAssessment: assessment ?? null }} prior={prior} />}
      <h3>Evidence</h3>
      <p>Checked at {answer.asOf}.</p>
      <ul>
        {schedule && hasScheduleEvidence && <li id={scheduleRef} tabIndex={-1}>{spreadsheet ? "Atlas project" : "Synthetic canonical schedule"} revision {schedule.revision}. Baseline {schedule.baseline ?? "unknown"}. Forecast {schedule.forecast ?? "unknown"}.
          {spreadsheet && <> Reviewed portfolio CSV receipt {spreadsheet.receiptId}, recorded at {spreadsheet.reviewedAt}.</>}
          {scheduleReceipt && <> Creation receipt {scheduleReceipt}.</>}
        </li>}
        {freshness && updateClaim && <li id={freshnessRef} tabIndex={-1}>Update assessment {updateClaim.evidenceIds[0]}. Assessed at {updateClaim.assessedAt}.{" "}
          {freshness.sourceDateField === "project.latestValidUpdateAt" ? "Latest verified update" : "Project created"}{" "}
          at {freshness.sourceDate}.
          {updateClaim.evidenceIds[1] && ` Open update obligation ${updateClaim.evidenceIds[1]}.`}
          {clarification && ` Clarification ${clarification.clarificationId} requested at ${clarification.requestedAt}.`}</li>}
        {integration && integrationClaim && <li id={integrationRef} tabIndex={-1}>Synthetic integration milestone {integration.milestoneId}. Planned start {integration.planned}. Actual start {integration.actual}.
          {" "}Creation receipt {answer.canonicalCreationReceiptId}.</li>}
        {blocker && <li id={blockerRef} tabIndex={-1}>Synthetic Jira issue {blocker.issueKey}, recorded in source mapping {blocker.mappingId}. System verified.
          {" "}Evidence {blocker.claim.evidenceIds.join(", ")}.</li>}
        {reply && <li id={replyRef} tabIndex={-1}>Human-confirmed owner reply {reply.responseId}, recorded at {reply.receivedAt}.</li>}
        {receipt && <li id={receiptRef} tabIndex={-1}>Simulated receipt {receipt.id}, fixture revision {receipt.fixtureRevision}, recorded at {receipt.recordedAt}.</li>}
        {escalation && <li id={escalationRef} tabIndex={-1}>Simulated PM escalation {escalation.requestId}, captured at {escalation.capturedAt}.</li>}
        {assessment && <li id={assessmentRef} tabIndex={-1}>Human-confirmed PM assessment {assessment.id} by {assessment.confirmedBy} at {assessment.confirmedAt}.</li>}
      </ul>
    </div>}
  </section><AtlasManagementSnapshot key={scope} projectId={projectId} scope={scope} request={request}
    isCurrent={isCurrent} canGenerate={Boolean(schedule && reply && receipt)} /></>;
}
