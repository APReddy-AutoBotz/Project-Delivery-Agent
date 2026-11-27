import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Message } from "./components.js";
import { decodeProjectLeadershipAnswer } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

export function ProjectLeadershipAnswer({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [question, setQuestion] = useState("");
  const ask = useMutation({ mutationFn: async ({ text }: { text: string; scope: string }) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const raw = await request(`/projects/${projectId}/leadership-answer`, {
      method: "POST", body: JSON.stringify({ question: text }),
    }, 4096, undefined, undefined, isCurrent);
    const answer = decodeProjectLeadershipAnswer(raw, projectId);
    if (!answer) throw new Error("Project answer unavailable");
    return answer;
  } });
  const current = ask.variables?.scope === scope && isCurrent();
  const result = current && ask.isSuccess ? ask.data : null;
  const answer = result?.state === "ANSWERED" ? result : null;
  const schedule = answer?.schedule;
  const days = schedule?.movementDays ?? null;
  const freshness = answer?.updateFreshness;
  const scheduleEvidence = `project-answer-schedule-${projectId}`;
  const updateEvidence = `project-answer-update-${projectId}`;

  return <section className="panel" aria-label="Project leadership answer">
    <h2>Ask about this project</h2>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (question.trim() && isCurrent() && !ask.isPending) ask.mutate({ text: question.trim(), scope });
    }}>
      <label className="field"><span>Project question</span>
        <input value={question} onChange={(event) => setQuestion(event.currentTarget.value)} maxLength={256}
          placeholder="Why is this project delayed?" />
      </label>
      <Button className="secondary" type="submit" disabled={!question.trim() || ask.isPending || !isCurrent()}>Ask</Button>
    </form>
    {current && ask.isPending && <p role="status">Checking project evidence…</p>}
    {current && ask.isError && <Message error>The project answer is unavailable.</Message>}
    {result?.state === "CLARIFY" && <Message>Ask about the current schedule or delay for the selected project.</Message>}
    {answer && <div aria-live="polite">
      <p>{days === null ? "Schedule movement is unavailable." : days === 0 ? "The baseline and forecast dates match."
        : `The forecast is ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"} than the baseline.`}
        {schedule && <> <a href={`#${scheduleEvidence}`}>Schedule evidence</a></>}
      </p>
      {days !== null && days > 0 && <p>The cause of the delay is unknown.</p>}
      {freshness && <p>The latest saved assessment found the project {freshness.state.toLowerCase()} under its update policy.
        {freshness.openObligation && " A project update remains due."} <a href={`#${updateEvidence}`}>Update evidence</a>
      </p>}
      <p>Checked at {answer.asOf}.</p>
      {(schedule || freshness) && <ul>
        {schedule && <li id={scheduleEvidence} tabIndex={-1}>Canonical schedule, revision {schedule.revision}.
          Baseline {schedule.baseline ?? "unknown"}. Forecast {schedule.forecast ?? "unknown"}.</li>}
        {freshness && <li id={updateEvidence} tabIndex={-1}>Assessment {freshness.assessmentId} at {freshness.assessedAt}.
          {freshness.sourceDateField === "project.latestValidUpdateAt" ? " Latest verified update" : " Project created"} at {freshness.sourceDate}.</li>}
      </ul>}
    </div>}
  </section>;
}
