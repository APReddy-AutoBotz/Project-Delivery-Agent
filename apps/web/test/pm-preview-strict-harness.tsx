import React, { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PmReconciliationPreview } from "../src/pm-reconciliation-preview-panel.js";
import { createPreviewRequestFactory } from "../src/pm-preview-request.js";
import { ManagedReadRegistry } from "../src/managed-read-registry.js";
import type { RequestFn } from "../src/request-types.js";

const projectId = "30000000-0000-4000-8000-000000000001";
const requestFactory = createPreviewRequestFactory({
  queueCurrent: () => true, projectIds: [projectId], registry: new ManagedReadRegistry(2), issuedSignals: new WeakSet(),
  request: async <T,>(...args: Parameters<RequestFn>): Promise<T> => {
    const [path, , , , managed] = args;
    if (!managed?.current()) throw new Error("Preview is unavailable.");
    ((window as Window & { previewPaths?: string[] }).previewPaths ??= []).push(path);
    // This harness makes no network request; the local operation is terminated.
    managed.completion("terminated");
    return { requests: [], next: null, live: true } as T;
  },
});

function Harness() {
  const invalidateRef = useRef<(() => void) | null>(null);
  return <PmReconciliationPreview projects={[{ projectId, name: "Synthetic project" }]}
    subject="synthetic-pm" requestFactory={requestFactory}
    openRequest={() => {}} invalidateRef={invalidateRef} isCurrentSession={() => true} />;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
