import React, { useEffect, useRef, useState } from "react";
import type { BlockerAgeAdvice } from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message } from "./components.js";
import { BlockerAgeObservation } from "./blocker-age-observation.js";
import { decodeBlockerAge } from "./pm-queue-decoder.js";
import { createPmQueueResource, type PmQueueResourceState } from "./pm-queue-resource.js";

export function LeadershipBlockerAge({ projectId, scope, request }: { projectId: string; scope: string; request: RequestFn }) {
  const loader = useRef(request);
  const resource = useRef<ReturnType<typeof createPmQueueResource<BlockerAgeAdvice>> | null>(null);
  const [state, setState] = useState<{ scope: string; value: PmQueueResourceState<BlockerAgeAdvice> }>({ scope, value: { phase: "loading" } });
  useEffect(() => { loader.current = request; }, [request]);
  useEffect(() => {
    const driver = createPmQueueResource<BlockerAgeAdvice>({
      load: async (signal) => decodeBlockerAge(await loader.current<unknown>(`/projects/${projectId}/leadership-blocker-age-suggestions`, { signal }), projectId, "leadership"),
      publish: (value) => setState({ scope, value }), visible: () => document.visibilityState === "visible",
    });
    resource.current = driver; driver.refresh();
    const revalidate = () => { if (document.visibilityState === "visible") driver.refresh(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", revalidate);
    return () => { driver.dispose(); if (resource.current === driver) resource.current = null;
      window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [scope, projectId]);
  const current = state.scope === scope ? state.value : { phase: "loading" as const };
  return <section className="panel space-y-4" aria-labelledby="leadership-blocker-age-heading">
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <span className="eyebrow">LEADERSHIP REVIEW</span><h2 id="leadership-blocker-age-heading">Blocker-age review</h2>
      <p className="muted">Age identifies items to review; it does not establish criticality or assign an owner. Access and information can change.</p>
    </div><Button className="secondary" onClick={() => resource.current?.refresh()}>Refresh blocker review</Button></div>
    {current.phase === "loading" && <p role="status">Checking current access and blocker information…</p>}
    {current.phase === "error" && <Message error>Blocker-age review is unavailable. Refresh to check access and current information.</Message>}
    {current.phase === "ready" && <BlockerAgeObservation facet={current.data} />}
  </section>;
}
