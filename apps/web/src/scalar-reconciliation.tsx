import React, { useEffect, useRef, useState } from "react";
import type {
  ScalarReconciliationCheckResult,
  ScalarReconciliationPage,
  ScalarReconciliationRequestSummary,
  ScalarReconciliationDelivery,
} from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, Message, SelectField } from "./components.js";
import { AssessmentView } from "./evidence-display.js";
import {
  denied,
  evidenceError,
  useEvidenceResource,
} from "./evidence-state.js";

type Base = { projectId: string; request: RequestFn };
export const savedScalarReconciliationLink = (
  projectId: string,
  requestId: string,
) =>
  `/?project=${encodeURIComponent(projectId)}&scalarReconciliation=${encodeURIComponent(requestId)}`;
const link = savedScalarReconciliationLink;
function Assignment({ item }: { item: ScalarReconciliationRequestSummary }) {
  return (
    <p>
      OPEN · Pending scalar reconciliation · Assignment revision{" "}
      {item.assignment.revision}:{" "}
      {item.assignment.reason === "ASSIGNED"
        ? `Assigned to ${item.assignment.recipientSubject}`
        : item.assignment.reason.replaceAll("_", " ")}
      . No source value has been changed.
    </p>
  );
}
// FR-EVD-007/009/012: explicit material action, separate from ordinary capture.
// A pending key stays bound to this mounted project/fact/session, including when
// periodic history checks temporarily hide the action.
export function ScalarReconciliationCheck({
  projectId,
  factId,
  request,
  visible,
  onCapture,
  onDenied,
  changed,
}: Base & {
  factId: string;
  visible: boolean;
  onCapture: (id: string) => void;
  onDenied: () => void;
  changed: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<Pick<
    ScalarReconciliationCheckResult,
    "checkId" | "outcome" | "replayed" | "request"
  > | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  async function check() {
    if (!visible || busy) return;
    const idempotencyKey = pending ?? crypto.randomUUID(),
      turn = ++sequence.current;
    setPending(idempotencyKey);
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const value = await request<ScalarReconciliationCheckResult>(
        `/projects/${projectId}/scalar-reconciliation-checks`,
        {
          method: "POST",
          body: JSON.stringify({ factId, idempotencyKey }),
        },
      );
      if (turn === sequence.current) {
        setPending(null);
        setResult({
          checkId: value.checkId,
          outcome: value.outcome,
          replayed: value.replayed,
          request: value.request,
        });
        onCapture(value.assessment.assessmentId);
        changed();
      }
    } catch (cause) {
      if (turn === sequence.current) {
        setError(evidenceError(cause));
        if (denied(cause)) {
          setPending(null);
          setResult(null);
          onDenied();
        }
      }
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Scalar reconciliation check" hidden={!visible}>
      <p>
        Check the whole scalar fact under its current authority policy. Eligible
        conflicts create or reuse an internal request; missing PM configuration
        leaves it unassigned.
      </p>
      <Button disabled={!visible || busy} onClick={() => void check()}>
        {busy
          ? "Checking scalar fact…"
          : pending
            ? "Retry same scalar check"
            : "Check and request reconciliation"}
      </Button>
      {error ? <Message error>{error}</Message> : null}
      {result ? (
        <div role="status">
          <p>
            Scalar check: {result.outcome}
            {result.replayed ? " · Replayed command" : ""}. A negative check
            does not close an existing request.
          </p>
          {result.request ? (
            <>
              <Assignment item={result.request} />
              <p>
                Link for the assigned PM, subject to current access:{" "}
                <a href={link(projectId, result.request.id)}>
                  Open scalar request
                </a>
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
function ScalarProof({
  projectId,
  request,
  requestId,
}: Base & { requestId: string }) {
  const proof = useEvidenceResource(
    `scalar-request:${projectId}:${requestId}`,
    () =>
      request<ScalarReconciliationDelivery>(
        `/projects/${projectId}/scalar-reconciliation-requests/${requestId}`,
      ),
  );
  return (
    <section aria-label="PM scalar reconciliation request">
      <h3>PM scalar reconciliation request</h3>
      <Button className="secondary" onClick={() => void proof.refresh()}>
        Refresh scalar request access
      </Button>
      {proof.phase === "loading" ? (
        <p role="status">Checking current scalar proof access…</p>
      ) : null}
      {proof.phase === "error" ? (
        <Message error>{evidenceError(proof.error)}</Message>
      ) : null}
      {proof.data ? (
        <>
          <Assignment item={proof.data.request} />
          <p>
            Original historical proof. Reconcile these retained values through
            the approved project process; this request does not select or
            resolve a source value.
          </p>
          <AssessmentView
            delivery={proof.data.assessment}
            projectId={projectId}
          />
        </>
      ) : null}
    </section>
  );
}
export function ScalarReconciliationQueue({
  projectId,
  request,
  visible,
  canAppend,
  generation,
  initialRequestId,
}: Base & {
  visible: boolean;
  canAppend: boolean;
  generation: number;
  initialRequestId?: string | null;
}) {
  const [mode, setMode] = useState<"recipient" | "manage">("recipient"),
    [after, setAfter] = useState<ScalarReconciliationPage["next"]>(null);
  const [requestId, setRequestId] = useState(initialRequestId ?? null),
    [error, setError] = useState("");
  const [pending, setPending] = useState<{
      requestId: string;
      expectedAssignmentRevision: number;
      idempotencyKey: string;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const query = after
    ? `?afterCreatedAt=${encodeURIComponent(after.createdAt)}&afterId=${after.id}`
    : "";
  const queue = useEvidenceResource(
    `scalar-queue:${projectId}:${mode}:${query}:${generation}`,
    () =>
      request<ScalarReconciliationPage>(
        `/projects/${projectId}/${mode === "manage" ? "managed-scalar-reconciliation-requests" : "scalar-reconciliation-requests"}${query}`,
      ),
    `scalar-queue:${projectId}:${mode}`,
  );
  useEffect(() => {
    if (queue.phase === "error" && denied(queue.error)) {
      sequence.current++;
      setPending(null);
      setBusy(false);
      setRequestId(null);
      setError("");
    }
  }, [queue.phase, queue.error]);
  async function refreshAssignment(item: ScalarReconciliationRequestSummary) {
    if (
      !visible ||
      !canAppend ||
      busy ||
      (pending && pending.requestId !== item.id)
    )
      return;
    const command = pending ?? {
        requestId: item.id,
        expectedAssignmentRevision: item.assignment.revision,
        idempotencyKey: crypto.randomUUID(),
      },
      turn = ++sequence.current;
    setPending(command);
    setBusy(true);
    setError("");
    try {
      await request(
        `/projects/${projectId}/scalar-reconciliation-requests/${command.requestId}/assignment`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedAssignmentRevision: command.expectedAssignmentRevision,
            idempotencyKey: command.idempotencyKey,
          }),
        },
      );
      if (turn === sequence.current) {
        setPending(null);
        void queue.refresh();
      }
    } catch (cause) {
      if (turn === sequence.current) {
        setError(evidenceError(cause));
        if (denied(cause)) {
          setPending(null);
          setRequestId(null);
          void queue.refresh();
        }
      }
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  return (
    <section
      className="evidence-history"
      aria-label="Scalar reconciliation queue"
    >
      <h3>Scalar reconciliation requests</h3>
      <p>
        Live, internal requests. No messages, approvals or source changes are
        performed.
      </p>
      <div hidden={!visible}>
        <SelectField
          label="Scalar request queue"
          value={mode}
          disabled={busy || pending !== null}
          onChange={(event) => {
            setMode(event.target.value as typeof mode);
            setAfter(null);
            setRequestId(null);
            setError("");
          }}
        >
          <option value="recipient">My assigned scalar requests</option>
          {canAppend ? (
            <option value="manage">Manage scalar requests</option>
          ) : null}
        </SelectField>
        <Button
          className="secondary"
          onClick={() => {
            setAfter(null);
            void queue.refresh();
          }}
        >
          Refresh scalar queue
        </Button>
        {queue.phase === "loading" ? (
          <p role="status">Checking current scalar queue access…</p>
        ) : null}
        {queue.phase === "error" ? (
          <Message error>{evidenceError(queue.error)}</Message>
        ) : null}
        {error ? <Message error>{error}</Message> : null}
        {pending ? (
          <Button
            disabled={busy}
            onClick={() => {
              setPending(null);
              setError("");
              void queue.refresh();
            }}
          >
            Discard scalar assignment retry and reload
          </Button>
        ) : null}
        {queue.data ? (
          <>
            {!queue.data.requests.length ? (
              <p>No scalar requests on this page.</p>
            ) : null}
            {queue.data.requests.map((item) => (
              <article className="evidence-entry" key={item.id}>
                <p>
                  {item.factType} · Created {item.createdAt}
                </p>
                <Assignment item={item} />
                {mode === "recipient" ? (
                  <Button
                    onClick={() => {
                      setRequestId(item.id);
                      window.history.replaceState(
                        {},
                        "",
                        link(projectId, item.id),
                      );
                    }}
                  >
                    Open scalar proof
                  </Button>
                ) : canAppend ? (
                  <Button
                    disabled={
                      busy ||
                      (pending !== null && pending.requestId !== item.id)
                    }
                    onClick={() => void refreshAssignment(item)}
                  >
                    {pending?.requestId === item.id
                      ? "Retry same scalar assignment refresh"
                      : "Refresh configured scalar PM assignment"}
                  </Button>
                ) : null}
              </article>
            ))}
            {after ? (
              <Button
                disabled={pending !== null}
                onClick={() => setAfter(null)}
              >
                First scalar request page
              </Button>
            ) : null}
            {queue.data.next ? (
              <Button
                disabled={pending !== null}
                onClick={() => setAfter(queue.data!.next)}
              >
                Next scalar request page
              </Button>
            ) : null}
          </>
        ) : null}
        {requestId && visible ? (
          <ScalarProof
            key={requestId}
            projectId={projectId}
            request={request}
            requestId={requestId}
          />
        ) : null}
      </div>
    </section>
  );
}
