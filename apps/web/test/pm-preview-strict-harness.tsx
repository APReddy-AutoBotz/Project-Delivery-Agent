import React, { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PmReconciliationPreview } from "../src/pm-reconciliation-preview-panel.js";

function Harness() {
  const invalidateRef = useRef<(() => void) | null>(null);
  return <PmReconciliationPreview projects={[{ projectId: "30000000-0000-4000-8000-000000000001", name: "Synthetic project" }]}
    subject="synthetic-pm" request={async () => ({ requests: [], next: null, live: true })}
    openRequest={() => {}} invalidateRef={invalidateRef} isCurrentSession={() => true} />;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
