import React, { useEffect, useState } from "react";
import type {
  ScalarReconciliationCheckResult,
  ScalarReconciliationContext,
  ScalarReconciliationDelivery,
  ScalarReconciliationPage,
  ScalarReconciliationRequestSummary,
  ReconciliationAssignmentResult,
} from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, TextField, SelectField, Message } from "./components.js";
import { FactValue } from "./evidence-display.js";
import {
  denied,
  evidenceError,
  useEvidenceResource,
  utcInstant,
  utcNow,
} from "./evidence-state.js";

export const savedScalarReconciliationLink = (
  projectId: string,
  requestId: string,
) =>
  `/?project=${encodeURIComponent(projectId)}&scalarReconciliation=${encodeURIComponent(requestId)}`;

type BaseProps = { projectId: string; request: RequestFn };

function LoadStatus({ phase, error }: { phase: string; error?: unknown }) {
  return phase === "loading" ? (
    <p role="status" className="muted">
      Checking current scalar reconciliation access…
    </p>
  ) : phase === "error" ? (
    <Message error>{evidenceError(error)}</Message>
  ) : null;
}

function AssignmentBadge({ item }: { item: ScalarReconciliationRequestSummary }) {
  const isAssigned = item.assignment.reason === "ASSIGNED";
  return (
    <div className="scalar-assignment-banner" style={{ margin: "10px 0" }}>
      <p style={{ margin: 0, fontWeight: 500 }}>
        Status:{" "}
        <span
          className={`pill ${item.state === "OPEN" ? "sapphire" : "neutral"}`}
          style={{
            background: item.state === "OPEN" ? "#EEF2FF" : "#F1F5F9",
            borderColor: item.state === "OPEN" ? "#C7D2FE" : "#E2E8F0",
            color: item.state === "OPEN" ? "#0F3460" : "#475569",
            fontWeight: 700,
          }}
        >
          {item.state}
        </span>{" "}
        · Assignment Rev {item.assignment.revision}:{" "}
        <span
          className="pill"
          style={{
            background: isAssigned ? "#EEF2FF" : "#FFF1F2",
            borderColor: isAssigned ? "#C7D2FE" : "#FECDD3",
            color: isAssigned ? "#0F3460" : "#9F1239",
            fontWeight: 600,
          }}
        >
          {isAssigned
            ? `Assigned to ${item.assignment.recipientSubject}`
            : item.assignment.reason.replaceAll("_", " ")}
        </span>
      </p>
      {!isAssigned && (
        <small className="muted" style={{ display: "block", marginTop: 4 }}>
          Durable unassigned routing:{" "}
          {item.assignment.reason === "NO_CONFIGURED_PM"
            ? "No configured Project Manager responsibility exists for this project."
            : item.assignment.reason === "AMBIGUOUS_CONFIGURED_PM"
              ? "Multiple Project Manager responsibilities are configured on this project."
              : "Configured Project Manager lacks an active project_manager grant."}
        </small>
      )}
    </div>
  );
}

export function ScalarProof({
  projectId,
  request,
  requestId,
  onResolved,
}: BaseProps & { requestId: string; onResolved?: () => void }) {
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const proof = useEvidenceResource(
    `scalar-reconciliation:${projectId}:${requestId}`,
    () =>
      request<ScalarReconciliationDelivery>(
        `/projects/${projectId}/scalar-reconciliation-requests/${requestId}`,
      ),
  );
  const delivery = proof.data;

  async function refreshAssignment() {
    if (!delivery) return;
    setRefreshBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await request<ReconciliationAssignmentResult>(
        `/projects/${projectId}/scalar-reconciliation-requests/${requestId}/assignment`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            requestId,
            expectedAssignmentRevision: delivery.request.assignment.revision,
            idempotencyKey: `sar_${Date.now()}`,
          }),
        },
      );
      setActionMessage(
        `Assignment refreshed to rev ${result.assignment.revision} (${result.assignment.reason}${result.replayed ? " - replayed" : ""}).`,
      );
      void proof.refresh();
    } catch (err) {
      setActionError(evidenceError(err));
    } finally {
      setRefreshBusy(false);
    }
  }

  async function resolveRequest() {
    if (!delivery) return;
    setResolveBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await request<ScalarReconciliationCheckResult>(
        `/projects/${projectId}/scalar-reconciliation-requests/${requestId}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            requestId,
            asOf: utcNow(),
            idempotencyKey: `srr_${Date.now()}`,
          }),
        },
      );
      if (result.outcome === "RESOLVED") {
        setActionMessage("Conflict successfully resolved!");
        onResolved?.();
      } else {
        setActionMessage(
          `Reassessment completed (${result.outcome}). Fact remains conflicting under current evidence.`,
        );
      }
      void proof.refresh();
    } catch (err) {
      setActionError(evidenceError(err));
    } finally {
      setResolveBusy(false);
    }
  }

  return (
    <section
      className="evidence-history panel"
      aria-label="Scalar reconciliation request"
      style={{
        background: "#FFFFFF",
        border: "1px solid #E2E8F0",
        borderRadius: 12,
        padding: 24,
        marginTop: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #E2E8F0",
          paddingBottom: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ margin: 0, color: "#0F3460", fontWeight: 700 }}>
            Scalar Reconciliation Request
          </h3>
          <small className="muted">Request reference: {requestId}</small>
        </div>
        <Button className="secondary" onClick={() => void proof.refresh()}>
          Refresh proof
        </Button>
      </div>

      <LoadStatus {...proof} />

      {delivery ? (
        <>
          <AssignmentBadge item={delivery.request} />
          <p className="muted" style={{ fontSize: 12, margin: "8px 0" }}>
            Fact type: <strong>{delivery.request.factType}</strong> · Created at:{" "}
            {delivery.request.createdAt} · Proof as of:{" "}
            {delivery.assessment.asOf}.
          </p>

          <div style={{ margin: "12px 0" }}>
            <a
              href={savedScalarReconciliationLink(projectId, requestId)}
              style={{ color: "#0F3460", fontWeight: 600, fontSize: 13 }}
            >
              Open saved scalar reconciliation link
            </a>
          </div>

          {delivery.assessment.visibility === "restricted" ? (
            <Message>
              Proof withheld. Underlying source access changed; revalidation
              required.
            </Message>
          ) : delivery.assessment.result ? (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  background: "#EEF2FF",
                  border: "1px solid #C7D2FE",
                  borderRadius: 8,
                  padding: "12px 16px",
                  color: "#0F3460",
                  marginBottom: 16,
                }}
              >
                <strong>
                  Status: {delivery.assessment.result.status} (
                  {delivery.assessment.result.conflict})
                </strong>
                <p style={{ margin: "4px 0 0", fontSize: 12 }}>
                  Two or more authoritative sources disagree on this scalar fact.
                  Neither value is automatically promoted without reconciliation.
                </p>
              </div>

              {/* Two-column structured conflict presentation */}
              <h4 style={{ color: "#0F3460", margin: "16px 0 8px" }}>
                Conflicting Evidence Positions
              </h4>
              <div
                className="conflict-comparison"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 16,
                  marginBottom: 20,
                }}
              >
                {delivery.assessment.result.versions
                  .filter(
                    (v) =>
                      v.visibility === "available" &&
                      (v.assessment.conflict === "CONFLICTING" ||
                        v.eligibilityReasons.length === 0),
                  )
                  .map((version, idx) => {
                    const isRestricted =
                      "visibility" in version && version.visibility === "restricted";
                    return (
                      <div
                        key={version.id}
                        style={{
                          background: "#FFFFFF",
                          border: "1px solid #E2E8F0",
                          borderRadius: 8,
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            borderBottom: "1px solid #F1F5F9",
                            paddingBottom: 8,
                            marginBottom: 10,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: 12,
                              color: "#0F3460",
                            }}
                          >
                            Source Position {idx + 1}
                          </span>
                          <span
                            className="pill"
                            style={{
                              background: isRestricted ? "#FFF1F2" : "#EEF2FF",
                              borderColor: isRestricted ? "#FECDD3" : "#C7D2FE",
                              color: isRestricted ? "#9F1239" : "#0F3460",
                              fontSize: 10,
                            }}
                          >
                            {isRestricted
                              ? "Restricted Access"
                              : `Tier ${version.authorityTier ?? "None"}`}
                          </span>
                        </div>
                        {isRestricted ? (
                          <div>
                            <p style={{ margin: "4px 0", fontSize: 12, color: "#64748B" }}>
                              Restricted authoritative version. Revalidation required.
                            </p>
                            <small style={{ color: "#94A3B8", fontSize: 10 }}>
                              Evidence IDs: {version.evidenceIds.join(", ")}
                            </small>
                          </div>
                        ) : (
                          <>
                            <div style={{ marginBottom: 8 }}>
                              <FactValue value={version.value} />
                            </div>
                            <dl
                              style={{
                                margin: 0,
                                fontSize: 11,
                                display: "grid",
                                gap: 4,
                              }}
                            >
                              <div>
                                <dt
                                  style={{
                                    display: "inline",
                                    color: "#64748B",
                                  }}
                                >
                                  Source:{" "}
                                </dt>
                                <dd style={{ display: "inline", margin: 0 }}>
                                  {version.source.recordId} (rev{" "}
                                  {version.source.revision})
                                </dd>
                              </div>
                              <div>
                                <dt
                                  style={{
                                    display: "inline",
                                    color: "#64748B",
                                  }}
                                >
                                  Provenance:{" "}
                                </dt>
                                <dd style={{ display: "inline", margin: 0 }}>
                                  {version.assessment.provenance}
                                </dd>
                              </div>
                              <div>
                                <dt
                                  style={{
                                    display: "inline",
                                    color: "#64748B",
                                  }}
                                >
                                  Freshness:{" "}
                                </dt>
                                <dd style={{ display: "inline", margin: 0 }}>
                                  {version.assessment.freshness}
                                </dd>
                              </div>
                              <div>
                                <dt
                                  style={{
                                    display: "inline",
                                    color: "#64748B",
                                  }}
                                >
                                  Version ID:{" "}
                                </dt>
                                <dd
                                  style={{
                                    display: "inline",
                                    margin: 0,
                                    fontFamily: "monospace",
                                    fontSize: 10,
                                  }}
                                >
                                  {version.id.slice(0, 8)}…
                                </dd>
                              </div>
                            </dl>
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>

              {/* Management actions */}
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  marginTop: 16,
                }}
              >
                <Button
                  className="secondary"
                  disabled={refreshBusy || delivery.request.state === "RESOLVED"}
                  onClick={() => void refreshAssignment()}
                >
                  {refreshBusy ? "Refreshing…" : "Refresh Assignment"}
                </Button>
                {delivery.request.state === "OPEN" && (
                  <Button
                    className="primary"
                    disabled={resolveBusy}
                    onClick={() => void resolveRequest()}
                  >
                    {resolveBusy ? "Reassessing…" : "Reassess and Resolve"}
                  </Button>
                )}
              </div>

              {actionMessage && (
                <div style={{ marginTop: 12 }}>
                  <Message>{actionMessage}</Message>
                </div>
              )}
              {actionError && (
                <div style={{ marginTop: 12 }}>
                  <Message error>{actionError}</Message>
                </div>
              )}
            </div>
          ) : (
            <Message>Original assessment proof unavailable.</Message>
          )}
        </>
      ) : null}
    </section>
  );
}

export function ScalarReconciliation({
  projectId,
  request,
  factType = "project.forecast",
  initialRequestId = null,
  visible = true,
}: BaseProps & {
  factType?: string;
  initialRequestId?: string | null;
  visible?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialRequestId);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"recipient" | "manage">("manage");

  const queue = useEvidenceResource(
    `scalar-queue:${projectId}:${viewMode}`,
    () =>
      request<ScalarReconciliationPage>(
        `/projects/${projectId}/scalar-reconciliation-requests${
          viewMode === "manage" ? "/manage" : ""
        }`,
      ),
  );

  async function triggerCheck() {
    setCheckBusy(true);
    setCheckMessage(null);
    setCheckError(null);
    try {
      const result = await request<ScalarReconciliationCheckResult>(
        `/projects/${projectId}/facts/${factType}/reconciliation-checks`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            factType,
            asOf: utcNow(),
            idempotencyKey: `sck_${Date.now()}`,
          }),
        },
      );
      setCheckMessage(
        `Check outcome: ${result.outcome}${
          result.replayed ? " (replayed)" : ""
        }. ${
          result.request
            ? `Request ${result.request.id} is ${result.request.state}.`
            : "No request required."
        }`,
      );
      if (result.request) {
        setSelectedId(result.request.id);
      }
      void queue.refresh();
    } catch (err) {
      setCheckError(evidenceError(err));
    } finally {
      setCheckBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      className="scalar-reconciliation-section panel"
      style={{
        background: "#FFFFFF",
        border: "1px solid #E2E8F0",
        borderRadius: 12,
        padding: 24,
        marginTop: 24,
        boxShadow: "0 1px 3px rgba(15, 52, 96, 0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #E2E8F0",
          paddingBottom: 14,
          marginBottom: 16,
        }}
      >
        <div>
          <span
            className="eyebrow"
            style={{
              color: "#0F3460",
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: 2,
            }}
          >
            DELIVERY ASSURANCE WORKFLOW
          </span>
          <h2 style={{ margin: "4px 0 0", color: "#0F3460", fontWeight: 700 }}>
            Scalar Conflict Reconciliation
          </h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Durable, traceable reconciliation requests for authoritative scalar
            conflicts.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div
            style={{
              background: "#F1F5F9",
              padding: 3,
              borderRadius: 8,
              display: "flex",
              gap: 2,
            }}
          >
            <Button
              className="text-button"
              style={{
                background: viewMode === "manage" ? "#0F3460" : "transparent",
                color: viewMode === "manage" ? "#FFFFFF" : "#64748B",
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 11,
                fontWeight: 600,
              }}
              onClick={() => setViewMode("manage")}
            >
              All Requests (Manage)
            </Button>
            <Button
              className="text-button"
              style={{
                background:
                  viewMode === "recipient" ? "#0F3460" : "transparent",
                color: viewMode === "recipient" ? "#FFFFFF" : "#64748B",
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 11,
                fontWeight: 600,
              }}
              onClick={() => setViewMode("recipient")}
            >
              My Queue
            </Button>
          </div>

          <Button
            className="primary"
            disabled={checkBusy}
            onClick={() => void triggerCheck()}
          >
            {checkBusy ? "Checking…" : `Check / Create (${factType})`}
          </Button>
        </div>
      </div>

      {checkMessage && (
        <div style={{ margin: "8px 0" }}>
          <Message>{checkMessage}</Message>
        </div>
      )}
      {checkError && (
        <div style={{ margin: "8px 0" }}>
          <Message error>{checkError}</Message>
        </div>
      )}

      <LoadStatus {...queue} />

      {queue.data && (
        <div>
          <h4 style={{ color: "#0F3460", margin: "14px 0 8px" }}>
            {viewMode === "manage"
              ? "All Reconciliation Requests"
              : "Assigned Requests"}
            {" ("}
            {queue.data.requests.length}
            {")"}
          </h4>

          {queue.data.requests.length === 0 ? (
            <p className="muted" style={{ fontStyle: "italic", fontSize: 13 }}>
              No scalar reconciliation requests in this queue.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gap: 8,
                maxHeight: 280,
                overflowY: "auto",
              }}
            >
              {queue.data.requests.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 14px",
                    background: selectedId === item.id ? "#EEF2FF" : "#F8FAFC",
                    border: `1px solid ${
                      selectedId === item.id ? "#C7D2FE" : "#E2E8F0"
                    }`,
                    borderRadius: 8,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                >
                  <div>
                    <strong style={{ color: "#0F3460", fontSize: 13 }}>
                      {item.factType}
                    </strong>
                    <span
                      className="muted"
                      style={{ fontSize: 11, marginLeft: 8 }}
                    >
                      ID: {item.id.slice(0, 8)}… · {item.createdAt.slice(0, 10)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span
                      className="pill"
                      style={{
                        background:
                          item.state === "OPEN" ? "#EEF2FF" : "#F1F5F9",
                        borderColor:
                          item.state === "OPEN" ? "#C7D2FE" : "#E2E8F0",
                        color: item.state === "OPEN" ? "#0F3460" : "#475569",
                        fontSize: 10,
                      }}
                    >
                      {item.state}
                    </span>
                    <span
                      className="pill"
                      style={{
                        background:
                          item.assignment.reason === "ASSIGNED"
                            ? "#EEF2FF"
                            : "#FFF1F2",
                        borderColor:
                          item.assignment.reason === "ASSIGNED"
                            ? "#C7D2FE"
                            : "#FECDD3",
                        color:
                          item.assignment.reason === "ASSIGNED"
                            ? "#0F3460"
                            : "#9F1239",
                        fontSize: 10,
                      }}
                    >
                      {item.assignment.reason === "ASSIGNED"
                        ? item.assignment.recipientSubject
                        : item.assignment.reason.replaceAll("_", " ")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedId && (
        <ScalarProof
          key={selectedId}
          projectId={projectId}
          requestId={selectedId}
          request={request}
          onResolved={() => void queue.refresh()}
        />
      )}
    </div>
  );
}
