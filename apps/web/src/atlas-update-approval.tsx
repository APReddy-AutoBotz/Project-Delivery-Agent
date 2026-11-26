import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { atlasApprovalProjectCode, AtlasAccessStatus, AtlasApprovalView, AtlasDelayAssessment } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import type { RequestFn } from "./request-types.js";
import { decodeAtlasApproval, decodeAtlasCommentReceipt, decodeAtlasDelayAssessment } from "./project-update-invitation-decoder.js";

export const atlasReviewProjectCode: typeof atlasApprovalProjectCode = "ATLAS-APPROVAL-DEMO";

function AtlasDelayConfirmation({ projectId, proposal, request, isCurrent, refresh }: {
  projectId: string; proposal: AtlasApprovalView; request: RequestFn; isCurrent: () => boolean; refresh: () => Promise<unknown>;
}) {
  const [confidence, setConfidence] = useState<AtlasDelayAssessment["confidence"] | "">("");
  const { delayReview, receipt } = proposal;
  const save = useMutation({
    mutationFn: async () => {
      if (!isCurrent() || !delayReview || !receipt || !confidence || Date.now() >= Date.parse(proposal.expiresAt))
        throw new Error("Atlas delay review is unavailable");
      const raw = await request(`/projects/${projectId}/atlas-delay-confirmation`, {
        method: "POST", body: JSON.stringify({ approvalId: proposal.approvalId, receiptId: receipt.id,
          scheduleRevision: delayReview.schedule.revision, cause: "API_ACCESS_DELAY", confidence }),
      }, 4096, undefined, undefined, isCurrent);
      const saved = decodeAtlasDelayAssessment(raw);
      if (saved?.approvalId !== proposal.approvalId || saved.receiptId !== receipt.id ||
          saved.scheduleRevision !== delayReview.schedule.revision || saved.confidence !== confidence)
        throw new Error("Atlas delay confirmation could not be verified");
    },
    onSuccess: () => isCurrent() ? refresh() : undefined,
  });
  if (!delayReview || !receipt || !isCurrent()) return null;
  const { schedule, assessment } = delayReview;
  return <section aria-label="Atlas delay assessment">
    <h3>Delay assessment</h3>
    <p>Baseline {schedule.baseline}. Forecast {schedule.forecast}. API access was pending in the owner’s confirmed reply.</p>
    {assessment ? <p>PM delay assessment recorded. Forecast confidence is {assessment.confidence.toLowerCase()}. Evidence {assessment.id}.</p>
      : <>
        <label>Forecast confidence
          <select value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)} disabled={save.isPending}>
            <option value="">Choose confidence</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </label>
        <Button className="primary" disabled={!confidence || save.isPending}
          onClick={() => save.mutate()}>Confirm API access caused the delay</Button>
      </>}
    {save.isError && <Message error>Could not record the delay assessment. Refresh the review before trying again.</Message>}
  </section>;
}

export function ConfirmAtlasReply({ locator, responseId, suggestion, request, isCurrent }: {
  locator: string; responseId: string; suggestion: AtlasAccessStatus | null; request: RequestFn; isCurrent: () => boolean;
}) {
  const [status, setStatus] = useState<AtlasAccessStatus | null>(suggestion);
  const [state, setState] = useState<"ready" | "saving" | "saved" | "failed">("ready");
  const sending = useRef(false);

  async function confirm() {
    if (!status || sending.current || !isCurrent()) return;
    sending.current = true;
    setState("saving");
    try {
      await request(`/project-update-invitations/${locator}/atlas-confirmation`, {
        method: "POST", body: JSON.stringify({ responseId, accessStatus: status }),
      }, 4096, undefined, undefined, isCurrent);
      if (isCurrent()) setState("saved");
    } catch {
      if (isCurrent()) setState("failed");
    } finally {
      sending.current = false;
    }
  }

  return <section aria-label="Atlas demo interpretation">
    <h3>Confirm the Atlas update</h3>
    {!suggestion && <p>Clarify whether API access is still pending or has been restored.</p>}
    <label className="field"><span>API access status</span>
      <select value={status ?? ""} disabled={state === "saving" || state === "saved"}
        onChange={(event) => {
          const selection = event.currentTarget.value;
          setStatus(selection === "ACCESS_PENDING" || selection === "ACCESS_RESTORED" ? selection : null);
        }}>
        <option value="">Choose a status</option>
        <option value="ACCESS_PENDING">Access pending</option>
        <option value="ACCESS_RESTORED">Access restored</option>
      </select>
    </label>
    <Button className="primary" disabled={!status || state === "saving" || state === "saved"}
      onClick={() => void confirm()}>Confirm for PM review</Button>
    {state === "saved" && <Message>Atlas demo interpretation confirmed for PM review.</Message>}
    {state === "failed" && <Message error>Could not confirm this reply. Check the latest response and try again.</Message>}
  </section>;
}

export function AtlasPmApproval({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const path = `/projects/${projectId}/atlas-approval`;
  const review = useQuery({
    queryKey: ["atlas-demo-approval", projectId, scope],
    queryFn: async () => {
      const raw = await request(path, undefined, 4096);
      if (raw === null) return null;
      const parsed = decodeAtlasApproval(raw);
      if (!parsed) throw new Error("Atlas review was unavailable");
      return parsed;
    },
    enabled: isCurrent(), retry: false, refetchOnWindowFocus: "always",
  });
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const proposal = review.isSuccess && !review.isFetching && isCurrent() ? review.data : null;
  const expiresAt = proposal?.expiresAt;
  const expired = expiresAt !== undefined && Date.now() >= Date.parse(expiresAt);
  const refresh = review.refetch;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [expiresAt, refresh]);

  async function submit(decision?: "APPROVED" | "REJECTED") {
    if (!proposal || sending.current || !isCurrent() || Date.now() >= Date.parse(proposal.expiresAt)) return;
    if (decision ? proposal.decision !== "PENDING" : proposal.decision !== "APPROVED" || proposal.receipt) return;
    sending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const raw = await request(decision ? path : `/projects/${projectId}/atlas-comment-receipt`, {
        method: "POST", body: JSON.stringify({ approvalId: proposal.approvalId, ...(decision && { decision }) }),
      }, 4096, undefined, undefined, isCurrent);
      if (decision) {
        const result = decodeAtlasApproval(raw);
        if (result?.approvalId !== proposal.approvalId || result.decision !== decision)
          throw new Error("Atlas decision could not be verified");
      } else if (decodeAtlasCommentReceipt(raw)?.approvalId !== proposal.approvalId) {
        throw new Error("Atlas receipt could not be verified");
      }
    } catch {
      if (isCurrent()) setFailed(true);
    } finally {
      if (isCurrent()) {
        await review.refetch();
        setBusy(false);
      }
      sending.current = false;
    }
  }

  return <section className="panel" aria-label="Atlas demo approval">
    <h2>Atlas demo approval</h2>
    {review.isFetching && <p role="status">Checking for a confirmed reply…</p>}
    {review.isError && <Message error>The Atlas review is unavailable.</Message>}
    {review.isSuccess && !review.isFetching && !proposal && <p>No current owner-confirmed reply.</p>}
    {proposal && <>
      <dl>
        <dt>Jira fixture</dt><dd>{proposal.target}</dd>
        <dt>Current comment at revision {proposal.sourceRevision}</dt><dd>{proposal.currentComment ?? "No comment in the fixture."}</dd>
        <dt>Proposed comment</dt><dd>{proposal.proposedComment}</dd>
        <dt>Evidence</dt><dd>Reply from {proposal.confirmedBy} received at {proposal.replyReceivedAt}</dd>
        <dt>Required approver</dt><dd>{proposal.approver}</dd>
        <dt>Review expires</dt><dd>{proposal.expiresAt}</dd>
      </dl>
      <p>This decision applies to the demo Jira fixture.</p>
      {proposal.decision !== "PENDING" ? <Message>{proposal.decision === "APPROVED" ? "Demo approval recorded." : "Demo rejection recorded."}</Message>
        : <div className="actions">
          <Button className="primary" disabled={busy || expired} onClick={() => void submit("APPROVED")}>Approve demo comment</Button>
          <Button className="secondary" disabled={busy || expired} onClick={() => void submit("REJECTED")}>Reject demo comment</Button>
        </div>}
      {proposal.decision === "APPROVED" && !proposal.receipt &&
        <Button className="primary" disabled={busy || expired} onClick={() => void submit()}>Record simulated comment</Button>}
      {proposal.receipt && <section aria-label="Simulated comment receipt">
        <h3>Simulated comment recorded</h3>
        <dl>
          <dt>Receipt ID</dt><dd>{proposal.receipt.id}</dd>
          <dt>Fixture revision</dt><dd>{proposal.receipt.fixtureRevision}</dd>
          <dt>Recorded at</dt><dd>{proposal.receipt.recordedAt}</dd>
        </dl>
      </section>}
      {proposal.delayReview && !expired && <AtlasDelayConfirmation key={proposal.receipt?.id} projectId={projectId}
        proposal={proposal} request={request} isCurrent={isCurrent} refresh={refresh} />}
    </>}
    {failed && <Message error>Could not verify the Atlas update. Review the current proposal before retrying.</Message>}
  </section>;
}
