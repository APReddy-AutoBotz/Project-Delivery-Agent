import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ProjectLeadershipAnswer as Answer, ProjectLeadershipFacts } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { RequestProjectDelayClarification } from "./project-delay-clarification.js";
import { decodeProjectLeadershipAnswer } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

const snapshotIdFormat = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function updateSource(update: ProjectLeadershipFacts["updateFreshness"]) {
  if (!update) return null;
  const label = update.sourceDateField === "project.createdAt" ? "Project created" : "Latest verified update";
  return `${label} at ${update.sourceDate}`;
}

function ProjectSnapshotComparison({ answer }: { answer: Extract<Answer, { state: "COMPARISON" }> }) {
  const { priorSnapshot: prior } = answer;
  const fields = [
    ["Baseline date", prior.schedule?.baseline, answer.schedule?.baseline],
    ["Forecast date", prior.schedule?.forecast, answer.schedule?.forecast],
    ["Update freshness", prior.updateFreshness?.state.toLowerCase(), answer.updateFreshness?.state.toLowerCase()],
    ["Update source", updateSource(prior.updateFreshness), updateSource(answer.updateFreshness)],
    ["Update obligation", prior.updateFreshness?.openObligation, answer.updateFreshness?.openObligation],
  ] as const;
  const changes = fields.filter(([, before, after]) => (before ?? null) !== (after ?? null));
  const display = (value: string | boolean | null | undefined) => typeof value === "boolean"
    ? value ? "Update due" : "No update due" : value ?? "Unavailable";
  return <section aria-label="Changes since the saved snapshot" aria-live="polite">
    <h3>Changes since the saved snapshot</h3>
    <p>Saved snapshot {prior.id} at {prior.asOf}. Current evidence checked at {answer.asOf}.</p>
    {changes.length ? <table>
      <thead><tr><th scope="col">Fact</th><th scope="col">Saved snapshot</th><th scope="col">Current</th></tr></thead>
      <tbody>{changes.map(([label, before, after]) => <tr key={label}>
        <th scope="row">{label}</th><td>{display(before)}</td><td>{display(after)}</td>
      </tr>)}</tbody>
    </table> : <p>No changes in the available fields.</p>}
    <ul>
      <li>Saved schedule revision {prior.schedule?.revision ?? "unavailable"} and update assessment {prior.updateFreshness?.assessmentId ?? "unavailable"}.</li>
      <li>Current schedule revision {answer.schedule?.revision ?? "unavailable"} and update assessment {answer.updateFreshness?.assessmentId ?? "unavailable"}.</li>
    </ul>
  </section>;
}

export function ProjectLeadershipAnswer({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [question, setQuestion] = useState("");
  const [snapshotInput, setSnapshotInput] = useState("");
  const snapshotId = snapshotInput.trim().toLowerCase();
  const ask = useMutation({ mutationFn: async ({ text, priorSnapshotId }: { text: string; scope: string; priorSnapshotId?: string }) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const raw = await request(`/projects/${projectId}/leadership-answer`, {
      method: "POST", body: JSON.stringify({ question: text, priorSnapshotId }),
    }, 8192, undefined, undefined, isCurrent);
    const answer = decodeProjectLeadershipAnswer(raw, projectId);
    if (!answer || (answer.state === "COMPARISON" ? answer.priorSnapshot.id : undefined) !== priorSnapshotId)
      throw new Error("Project answer unavailable");
    return answer;
  } });
  const current = ask.variables?.scope === scope && isCurrent();
  const result = current && ask.isSuccess ? ask.data : null;
  const answer = result?.state === "ANSWERED" ? result : null;
  const confirmed = answer?.cause === "HUMAN_CONFIRMED" ? answer.delayCause : null;
  const expiry = confirmed?.claim.validUntil;
  const cause = confirmed && (!expiry || Date.parse(expiry) > Date.now()) ? confirmed : null;
  const submitted = ask.variables;
  const refresh = ask.mutate;
  const latestQuestion = useRef<typeof submitted>(undefined);
  const submitQuestion = (value: NonNullable<typeof submitted>) => {
    latestQuestion.current = value;
    refresh(value);
  };
  useEffect(() => {
    if (!expiry || !submitted) return;
    const delay = Date.parse(expiry) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => {
      if (isCurrent() && latestQuestion.current === submitted) refresh(submitted);
    }, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiry, isCurrent, refresh, submitted]);
  const schedule = answer?.schedule;
  const days = schedule?.movementDays ?? null;
  const freshness = answer?.updateFreshness;
  const scheduleEvidence = `project-answer-schedule-${projectId}`;
  const updateEvidence = `project-answer-update-${projectId}`;
  const causeEvidence = `project-answer-cause-${projectId}`;

  return <section className="panel" aria-label="Project leadership answer">
    <h2>Ask about this project</h2>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (question.trim() && isCurrent() && !ask.isPending) submitQuestion({ text: question.trim(), scope });
    }}>
      <label className="field"><span>Project question</span>
        <input value={question} onChange={(event) => setQuestion(event.currentTarget.value)} maxLength={256}
          placeholder="Why is this project delayed?" />
      </label>
      <Button className="secondary" type="submit" disabled={!question.trim() || ask.isPending || !isCurrent()}>Ask</Button>
    </form>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (snapshotIdFormat.test(snapshotId) && isCurrent() && !ask.isPending)
        submitQuestion({ text: "What changed since this snapshot?", scope, priorSnapshotId: snapshotId });
    }}>
      <label className="field"><span>Saved snapshot ID</span>
        <input value={snapshotInput} onChange={(event) => setSnapshotInput(event.currentTarget.value)} maxLength={36} />
      </label>
      <Button className="secondary" type="submit" disabled={!snapshotIdFormat.test(snapshotId) || ask.isPending || !isCurrent()}>
        Compare with current facts
      </Button>
    </form>
    {current && ask.isPending && <p role="status">Checking project evidence…</p>}
    {current && ask.isError && <Message error>The project answer is unavailable.</Message>}
    {result?.state === "CLARIFY" && <Message>Ask about the current schedule or delay for the selected project.</Message>}
    {result?.state === "COMPARISON" && <ProjectSnapshotComparison answer={result} />}
    {answer && <div aria-live="polite">
      <p>{days === null ? "Schedule movement is unavailable." : days === 0 ? "The baseline and forecast dates match."
        : `The forecast is ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"} than the baseline.`}
        {schedule && <> <a href={`#${scheduleEvidence}`}>Schedule evidence</a></>}
      </p>
      {cause && <p className="update-plain-text">{cause.claim.claimText} <a href={`#${causeEvidence}`}>
        Cause evidence</a></p>}
      {confirmed && !cause && <p>The cause evidence has expired. Ask again to check current evidence.</p>}
      {answer.cause === "UNKNOWN" && schedule && days !== null && days > 0 && <>
        <p>The cause of the delay is unknown.</p>
        {answer.pendingDelayClarification ?
          <p>Delay evidence requested. Request {answer.pendingDelayClarification.id}.</p> :
          <RequestProjectDelayClarification key={JSON.stringify([scope, schedule.revision])}
            projectId={projectId} schedule={schedule} request={request} isCurrent={isCurrent} />}
      </>}
      {freshness && <p>The latest saved assessment found the project {freshness.state.toLowerCase()} under its update policy.
        {freshness.openObligation && " A project update remains due."} <a href={`#${updateEvidence}`}>Update evidence</a>
      </p>}
      <p>Checked at {answer.asOf}.</p>
      {(schedule || freshness) && <ul>
        {schedule && <li id={scheduleEvidence} tabIndex={-1}>Canonical schedule, revision {schedule.revision}.
          Baseline {schedule.baseline ?? "unknown"}. Forecast {schedule.forecast ?? "unknown"}.</li>}
        {freshness && <li id={updateEvidence} tabIndex={-1}>Assessment {freshness.assessmentId} at {freshness.assessedAt}.
          {freshness.sourceDateField === "project.latestValidUpdateAt" ? " Latest verified update" : " Project created"} at {freshness.sourceDate}.
          {freshness.obligationId && ` Open update obligation ${freshness.obligationId}.`}</li>}
        {cause && <li id={causeEvidence} tabIndex={-1}>
          Evidence {cause.claim.evidenceIds[0]}. PM confirmation {cause.confirmation.id} at {cause.confirmation.confirmedAt}.
        </li>}
      </ul>}
    </div>}
  </section>;
}
