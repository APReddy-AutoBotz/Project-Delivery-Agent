import React, { useEffect, useRef, useState } from "react";
import { Button, Message } from "./components.js";
import type { RequestFn } from "./request-types.js";
import { decodeUnrankedMilestone } from "./unranked-milestone-decoder.js";
import { createUnrankedMilestoneResource } from "./unranked-milestone-resource.js";
import type { createUnrankedRequestLease } from "./unranked-milestone-lease.js";
import type { createUnrankedPageLifecycle } from "./unranked-page-lifecycle.js";

type Resource = ReturnType<typeof createUnrankedMilestoneResource>;
type ViewState = ReturnType<Resource["current"]>;
type Session = { customerId: string; subject: string; generation: number };
type Owner = { identity: string; resource: Resource; lease: ReturnType<typeof createUnrankedRequestLease>;
  lifecycle: ReturnType<typeof createUnrankedPageLifecycle> };
const idle: ViewState = { phase: "idle" };
const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
  value === "00000000-0000-0000-0000-000000000000" || value === "ffffffff-ffff-ffff-ffff-ffffffffffff";

// Unmounted local component. The owner must reuse lease across remounts and
// advance both session and selection generations on every relevant change.
export function UnrankedMilestoneView({ session, selectionGeneration, projectId, milestoneId, request, lease, lifecycle }: {
  session: Session | null; selectionGeneration: number; projectId: string; milestoneId: string;
  request: RequestFn; lease: ReturnType<typeof createUnrankedRequestLease>; lifecycle: ReturnType<typeof createUnrankedPageLifecycle>;
}) {
  const validSession = session && validId(session.customerId) && session.subject && validId(projectId) && validId(milestoneId) &&
    Number.isSafeInteger(session.generation) && session.generation >= 0 && Number.isSafeInteger(selectionGeneration) && selectionGeneration >= 0;
  const identity = validSession ? JSON.stringify([session.customerId, session.subject, session.generation, selectionGeneration, projectId, milestoneId]) : null;
  const loader = useRef(request), owner = useRef<Owner | null>(null);
  const [published, setPublished] = useState<{ identity: string; holder: Owner; value: ViewState } | null>(null);
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    const resource = createUnrankedMilestoneResource({
      load: (signal) => lease.run(signal, async () => decodeUnrankedMilestone(await loader.current<unknown>(
        `/projects/${projectId}/milestones/${milestoneId}/leadership-unranked-state-reports`, { signal }, 262144,
        () => resource.unavailable(signal)), projectId, milestoneId)),
      publish: (value) => { if (live && owner.current === holder) setPublished({ identity, holder, value }); },
    });
    const holder: Owner = { identity, resource, lease, lifecycle }; owner.current = holder; setPublished({ identity, holder, value: idle });
    const syncVisibility = (revalidate: boolean) => {
      const visible = lifecycle.visible(); resource.setVisible(visible);
      if (visible && revalidate) resource.revalidate();
    };
    const unsubscribe = lifecycle.subscribe(syncVisibility); syncVisibility(false);
    return () => {
      live = false; unsubscribe(); if (owner.current === holder) owner.current = null; resource.dispose();
    };
  }, [identity, projectId, milestoneId, lease, lifecycle]);
  if (!identity) return null;
  const current = published?.identity === identity && published.holder.lease === lease && published.holder.lifecycle === lifecycle
    ? published.holder.resource.current() : idle;
  return <div className="space-y-3">
    <Button className="secondary" onClick={() => { if (owner.current?.identity === identity && owner.current.lease === lease &&
      owner.current.lifecycle === lifecycle) owner.current.resource.refresh(); }}>
      Check human milestone reports
    </Button>
    <div aria-live="polite" aria-atomic="true">
      {current.phase === "loading" && <p role="status">Checking milestone reports…</p>}
      {current.phase === "error" && <Message error>Milestone reports could not be established. Check access and try again.</Message>}
      {current.phase === "ready" && <>
        <p>Stored human reports differ about this milestone. No state has been selected as the winner.</p>
        <p className="muted">Checked at {current.data.asOf}. Reports, access or policy may have changed; refresh before relying on this observation. Stored provenance does not independently verify authorship.</p>
        {current.data.positions.map((position) => <div className="canonical-review-row" key={position.state}>
          <p><strong>{position.state.replaceAll("_", " ")}</strong></p>
          <ul>{position.supports.map((support) => <li key={support.versionId}>
            Evidence {support.evidenceId} · version {support.versionId} · source {support.sourceId} · observed {support.observedAt} · valid until {support.versionValidUntil}
          </li>)}</ul>
        </div>)}
      </>}
    </div>
  </div>;
}
