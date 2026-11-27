import React, { useEffect, useRef, useState } from "react";
import type { BlockerAgeAdvice } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { BlockerAgeObservation } from "./blocker-age-observation.js";
import { decodeBlockerAge } from "./pm-queue-decoder.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

export function BlockerAgeReview({ projectId, scope, request, audience }: {
  projectId: string; scope: string; request: RequestFn; audience: "leadership" | "scrum_master";
}) {
  const resource = useRef<ReturnType<typeof createPmQueueResource<BlockerAgeAdvice>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<BlockerAgeAdvice> }>({ scope, value: { phase: "loading" } });
  useEffect(() => {
    const path = audience === "leadership" ? "leadership-blocker-age-suggestions" : "scrum-master-blocker-age-suggestions";
    const driver = createPmQueueResource<BlockerAgeAdvice>({
      load: async (signal) => decodeBlockerAge(await request<unknown>(`/projects/${projectId}/${path}`, { signal }), projectId, audience),
      publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, projectId, request, audience]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  const headingId = audience + "-blocker-age-heading";
  return <section className="panel space-y-4" aria-labelledby={headingId}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <span className="eyebrow">{audience === "leadership" ? "LEADERSHIP REVIEW" : "SPRINT REVIEW"}</span>
      <h2 id={headingId}>{audience === "leadership" ? "Blocker-age review" : "Sprint impediments"}</h2>
      <p className="muted">Age identifies items to review; it does not establish criticality or assign an owner. Access and information can change.</p>
    </div><Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh blocker review</Button></div>
    {current.phase === "loading" && <p role="status">Checking current access and blocker information…</p>}
    {current.phase === "error" && <Message error>Blocker-age review is unavailable. Refresh to check access and current information.</Message>}
    {current.phase === "ready" && <BlockerAgeObservation facet={current.data} />}
  </section>;
}
