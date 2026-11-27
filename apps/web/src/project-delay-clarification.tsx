import { useMutation } from "@tanstack/react-query";
import type { ProjectLeadershipSchedule } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { decodeProjectDelayCauseConfirmation, decodeProjectDelayClarification,
  decodeProjectDelayClarificationReview } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

type ClarificationAccess = { projectId: string; request: RequestFn; isCurrent: () => boolean };

export function delayClarificationQuestion(schedule: ProjectLeadershipSchedule) {
  return `What caused the forecast finish date to move from ${schedule.baseline} to ${schedule.forecast}? Please link the evidence that confirms the cause.`;
}

export function RequestProjectDelayClarification({ projectId, request, isCurrent, schedule }: ClarificationAccess & {
  schedule: ProjectLeadershipSchedule;
}) {
  const ask = useMutation({ mutationFn: async () => {
    if (!isCurrent()) throw new Error("Project access changed");
    const value = await request(`/projects/${projectId}/delay-clarification`, {
      method: "POST", body: JSON.stringify({ scheduleRevision: schedule.revision }),
    }, 4096, undefined, undefined, isCurrent);
    const saved = decodeProjectDelayClarification(value);
    if (!isCurrent() || saved?.schedule.revision !== schedule.revision || saved.schedule.baseline !== schedule.baseline ||
        saved.schedule.forecast !== schedule.forecast) throw new Error("Delay request unavailable");
    return saved;
  } });
  if (!isCurrent()) return null;
  return <details>
    <summary>Draft a question for the assigned PM</summary>
    <p>{delayClarificationQuestion(schedule)}</p>
    {ask.isSuccess ? <p role="status">Delay evidence requested. Request {ask.data.id}.</p> :
      <Button className="secondary" disabled={ask.isPending} onClick={() => ask.mutate()}>
        {ask.isPending ? "Recording request…" : "Ask the assigned PM"}
      </Button>}
    {ask.isError && <Message error>Could not record the delay request. Check the current schedule and try again.</Message>}
  </details>;
}

export function ProjectDelayClarificationReview({ projectId, scope, request, isCurrent }: ClarificationAccess & { scope: string }) {
  const path = `/projects/${projectId}/delay-clarification`;
  const review = useMutation({ mutationFn: async (_scope: string) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const value = await request(path, { cache: "no-store" }, 4096,
      undefined, undefined, isCurrent);
    if (!isCurrent()) throw new Error("Project access changed");
    if (value === null) return null;
    const saved = decodeProjectDelayClarificationReview(value);
    if (!saved) throw new Error("Delay request unavailable");
    return saved;
  } });
  const confirm = useMutation({ mutationFn: async ({ clarificationId, versionId }: {
    scope: string; clarificationId: string; versionId: string;
  }) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const value = await request(path + "/confirmation", { method: "POST", body: JSON.stringify({ clarificationId, versionId }) },
      4096, undefined, undefined, isCurrent);
    const saved = decodeProjectDelayCauseConfirmation(value);
    if (!isCurrent() || saved?.clarificationId !== clarificationId || saved.versionId !== versionId)
      throw new Error("Delay confirmation unavailable");
    return saved;
  } });
  const current = review.variables === scope && isCurrent();
  const clarification = current && review.isSuccess ? review.data : null;
  const cause = clarification?.causeEvidence;
  const sameConfirmation = confirm.variables?.scope === scope && confirm.variables.clarificationId === clarification?.id &&
    confirm.variables.versionId === cause?.versionId;
  const confirmation = clarification?.confirmation ?? (sameConfirmation && confirm.isSuccess ? confirm.data : null);
  return <section className="panel" aria-label="Project delay evidence request">
    <h2>Delay evidence request</h2>
    <Button className="secondary" disabled={review.isPending || confirm.isPending || !isCurrent()} onClick={() => review.mutate(scope)}>
      Check delay requests
    </Button>
    {current && review.isPending && <p role="status">Checking delay requests…</p>}
    {current && review.isError && <Message error>The delay request is unavailable.</Message>}
    {current && review.isSuccess && !clarification && <p>No active delay request for this schedule.</p>}
    {clarification && <div aria-live="polite">
      <p>{delayClarificationQuestion(clarification.schedule)}</p>
      <p>Schedule revision {clarification.schedule.revision}. Requested at {clarification.requestedAt} (UTC).</p>
      <p>Request {clarification.id}.</p>
      {cause ? <>
        <p className="update-plain-text">{cause.value}</p>
        <p>Evidence {cause.evidenceId} at {cause.observedAt} (UTC).</p>
        {confirmation ? <p role="status">Delay cause confirmed. Receipt {confirmation.id}.</p> :
          <Button className="primary" disabled={confirm.isPending || !isCurrent()}
            onClick={() => confirm.mutate({ scope, clarificationId: clarification.id, versionId: cause.versionId })}>
            {confirm.isPending ? "Confirming cause…" : "Confirm this delay cause"}
          </Button>}
      </> : <p>Use Project evidence to record an authorized project.delay_cause statement for this review.</p>}
      {sameConfirmation && confirm.isError && <Message error>Could not confirm the cause. Check the latest evidence and try again.</Message>}
    </div>}
  </section>;
}
