import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Message } from "./components.js";
import { decodeAtlasLeadershipAnswer } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

export function AtlasLeadershipAnswer({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [asked, setAsked] = useState(false);
  const query = useQuery({
    queryKey: ["atlas-leadership-answer", projectId, scope],
    enabled: asked && isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const data = decodeAtlasLeadershipAnswer(await request(`/projects/${projectId}/atlas-leadership-answer`, undefined, 4096), projectId);
      if (!data) throw new Error("Atlas leadership answer unavailable");
      return data;
    },
  });
  const refresh = query.refetch;
  const answer = asked && isCurrent() && query.isSuccess && !query.isFetching ? query.data : null;
  const expiry = answer?.ownerReply?.availableUntil;
  useEffect(() => {
    if (!expiry) return;
    const delay = Date.parse(expiry) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [expiry, refresh]);
  const reply = answer?.ownerReply && Date.parse(answer.ownerReply.availableUntil) > Date.now() ? answer.ownerReply : null;
  const receipt = reply ? answer?.receipt : null;
  const schedule = answer?.schedule;
  const scheduleRef = `atlas-schedule-${projectId}`;
  const replyRef = `atlas-reply-${projectId}`;
  const receiptRef = `atlas-receipt-${projectId}`;
  const days = schedule?.movementDays ?? null;
  const movement = days === null ? "Schedule movement is unavailable."
    : days === 0 ? "The baseline and forecast dates match."
      : `The forecast is ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"} than the baseline.`;

  return <section className="panel" aria-label="Atlas leadership answer">
    <h2>Atlas delivery question</h2>
    <Button className="secondary" disabled={query.isFetching || !isCurrent()} onClick={() => {
      if (asked) void refresh();
      else setAsked(true);
    }}>Why is Atlas delayed?</Button>
    {asked && query.isFetching && <p role="status">Checking Atlas evidence…</p>}
    {asked && query.isError && <Message error>The Atlas answer is unavailable.</Message>}
    {answer && <div aria-live="polite">
      <p>{movement} {schedule && <a href={`#${scheduleRef}`}>Schedule evidence</a>}</p>
      {reply && <p>The owner confirmed API access was {reply.accessStatus === "ACCESS_PENDING" ? "pending" : "restored"} at the time of the reply.{" "}
        <a href={`#${replyRef}`}>Reply evidence</a></p>}
      {receipt && <p>The PM recorded a simulated comment for {receipt.target}.{" "}
        <a href={`#${receiptRef}`}>Receipt evidence</a></p>}
      {(!reply || !receipt) && <p>Some reply or action evidence is unavailable for this answer.</p>}
      <p>The verified cause of the schedule change and confidence in the forecast remain unknown.</p>
      <h3>Evidence</h3>
      <p>Checked at {answer.asOf}.</p>
      <ul>
        {schedule && <li id={scheduleRef} tabIndex={-1}>Synthetic canonical schedule, revision {schedule.revision}. Baseline {schedule.baseline ?? "unknown"}. Forecast {schedule.forecast ?? "unknown"}.</li>}
        {reply && <li id={replyRef} tabIndex={-1}>Human-confirmed owner reply {reply.responseId}, recorded at {reply.receivedAt}.</li>}
        {receipt && <li id={receiptRef} tabIndex={-1}>Simulated receipt {receipt.id}, fixture revision {receipt.fixtureRevision}, recorded at {receipt.recordedAt}.</li>}
      </ul>
    </div>}
  </section>;
}
