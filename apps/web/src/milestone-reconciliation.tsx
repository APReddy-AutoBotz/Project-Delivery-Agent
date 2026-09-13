import React, { useEffect, useRef, useState } from "react";
import type {
  CanonicalProjectDetail,
  ReconciliationAssignmentResult,
  ReconciliationCheckResult,
  ReconciliationContext,
  ReconciliationDelivery,
  ReconciliationPage,
  ReconciliationRequestSummary,
  StateBindingCreate,
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

export const savedReconciliationLink = (projectId: string, requestId: string) =>
  `/?project=${encodeURIComponent(projectId)}&reconciliation=${encodeURIComponent(requestId)}`;
type BaseProps = { projectId: string; request: RequestFn };
function LoadStatus({ phase, error }: { phase: string; error?: unknown }) {
  return phase === "loading" ? (
    <p role="status">Checking current reconciliation access…</p>
  ) : phase === "error" ? (
    <Message error>{evidenceError(error)}</Message>
  ) : null;
}
function Assignment({ item }: { item: ReconciliationRequestSummary }) {
  return (
    <p>
      Pending reconciliation · OPEN · Assignment revision{" "}
      {item.assignment.revision}:{" "}
      {item.assignment.reason === "ASSIGNED"
        ? `Assigned to ${item.assignment.recipientSubject}`
        : item.assignment.reason.replaceAll("_", " ")}
      . No source value has been changed.
    </p>
  );
}

// FR-EVD-009/010: only the currently authorized response is rendered; no browser
// persistence or claim that a server-side request was sent/read/approved.
function Proof({
  projectId,
  request,
  requestId,
}: BaseProps & { requestId: string }) {
  const proof = useEvidenceResource(
    `reconciliation:${projectId}:${requestId}`,
    () =>
      request<ReconciliationDelivery>(
        `/projects/${projectId}/reconciliation-requests/${requestId}`,
      ),
  );
  const delivery = proof.data;
  return (
    <section
      className="evidence-history"
      aria-label="PM reconciliation request"
    >
      <h3>PM reconciliation request</h3>
      <Button className="secondary" onClick={() => void proof.refresh()}>
        Refresh request access
      </Button>
      <LoadStatus {...proof} />
      {delivery ? (
        <>
          <Assignment item={delivery.request} />
          <p>
            Historical proof as of {delivery.assessment.asOf}. CURRENT below
            means current at capture, not verified now. This request remains
            unresolved.
          </p>
          <a href={savedReconciliationLink(projectId, requestId)}>
            Open saved reconciliation link
          </a>
          {delivery.assessment.visibility === "restricted" ? (
            <Message>
              Proof withheld. Source access or verification changed;
              revalidation required.
            </Message>
          ) : delivery.assessment.result.status === "CONFLICTING" ? (
            <>
              <p className="evidence-warning">
                CONFLICTING: a milestone was reported COMPLETE while mandatory
                linked work was OPEN or IN_PROGRESS. Neither position is a
                settled overall completion claim. Please reconcile the retained
                evidence through the approved project process.
              </p>
              {delivery.assessment.result.evaluations.map((target) => (
                <article
                  key={target.targetId}
                  className="evidence-entry"
                  aria-label={`${target.targetKind} evidence ${target.targetId}`}
                >
                  <h4>
                    {target.targetKind === "MILESTONE"
                      ? "Milestone"
                      : "Mandatory work item"}{" "}
                    {target.targetId}
                  </h4>
                  {target.assessment?.resolvedValue ? (
                    <p>
                      Value at capture:{" "}
                      <FactValue value={target.assessment.resolvedValue} />
                    </p>
                  ) : null}
                  {target.assessment?.versions.map((version) => (
                    <div key={version.id}>
                      {version.visibility === "available" ? (
                        <>
                          <FactValue value={version.value} />
                          <p className="evidence-badges">
                            <strong>{version.assessment.classification}</strong>{" "}
                            · Provenance: {version.assessment.provenance} ·
                            Freshness: {version.assessment.freshness} ·
                            Conflict: {version.assessment.conflict}
                          </p>
                          <p>
                            Applicability: {version.temporalApplicability} ·
                            Assessed validity ends:{" "}
                            {version.assessedValidUntil ?? "Unknown"}
                          </p>
                          <p>
                            Source record: {version.source.recordId} · Source
                            revision: {version.source.revision}
                          </p>
                        </>
                      ) : (
                        <p>Evidence was restricted at capture.</p>
                      )}
                      <details>
                        <summary>Retained evidence references</summary>
                        <p>Version: {version.id}</p>
                        <p>Evidence: {version.evidenceIds.join(", ")}</p>
                      </details>
                    </div>
                  ))}
                </article>
              ))}
            </>
          ) : (
            <Message>Original proof is unavailable for reconciliation.</Message>
          )}
        </>
      ) : null}
    </section>
  );
}

function BindingForm({
  projectId,
  request,
  target,
  onSaved,
  onDenied,
}: BaseProps & {
  target: ReconciliationContext["targets"][number];
  onSaved: () => void;
  onDenied: () => void;
}) {
  const [state, setState] = useState("OPEN"),
    [effectiveAt, setEffectiveAt] = useState(utcNow),
    [validUntil, setValidUntil] = useState(""),
    [statement, setStatement] = useState("");
  const [review, setReview] = useState<StateBindingCreate | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  async function save() {
    if (!review || busy) return;
    const turn = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      await request(`/projects/${projectId}/state-bindings`, {
        method: "POST",
        body: JSON.stringify(review),
      });
      if (turn === sequence.current) {
        setReview(null);
        setStatement("");
        onSaved();
      }
    } catch (cause) {
      if (turn === sequence.current) {
        setError(evidenceError(cause));
        if (denied(cause)) {
          setReview(null);
          setStatement("");
          onDenied();
        }
      }
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  return (
    <form
      className="evidence-form"
      aria-label="Bind canonical state"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          const effective = utcInstant(effectiveAt),
            until = validUntil ? utcInstant(validUntil) : null;
          if (until && until < effective)
            throw new Error("Expiry must not precede effective time.");
          setReview({
            projectId,
            targetKind: target.targetKind,
            targetId: target.targetId,
            initialState: state as StateBindingCreate["initialState"],
            effectiveAt: effective,
            validUntil: until,
            originalStatement: statement,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch (cause) {
          setError((cause as Error).message);
        }
      }}
    >
      <h4>Record initial human-confirmed state</h4>
      <p>
        This creates fresh evidence bound to this canonical target. It does not
        edit its configured state, add an authority policy, or share evidence
        with the PM.
      </p>
      {!review ? (
        <>
          <SelectField
            label="Initial evidence state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            {["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </SelectField>
          <TextField
            label="State effective at (UTC)"
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
            required
          />
          <TextField
            label="State valid until (UTC, optional)"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
          <TextField
            label="Original state statement"
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            maxLength={8192}
            required
          />
          <Button type="submit">Review state binding</Button>
        </>
      ) : (
        <>
          <p>
            HUMAN_CONFIRMED · {review.initialState} · {review.originalStatement}
          </p>
          <p>
            Effective: {review.effectiveAt} · Valid until:{" "}
            {review.validUntil ?? "Unknown"}
          </p>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Confirm state binding"}
          </Button>
          <Button
            disabled={busy}
            className="secondary"
            onClick={() => {
              setReview(null);
              setError("");
            }}
          >
            Discard reviewed binding
          </Button>
          <p>If the outcome is uncertain, retry the same reviewed binding.</p>
        </>
      )}
      {error ? <Message error>{error}</Message> : null}
    </form>
  );
}

function MilestoneCheck({
  projectId,
  request,
  milestoneId,
  changed,
}: BaseProps & { milestoneId: string; changed: () => void }) {
  const [targetId, setTargetId] = useState<string | null>(null),
    [generation, setGeneration] = useState(0),
    [pending, setPending] = useState<{ idempotencyKey: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<ReconciliationCheckResult | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const context = useEvidenceResource(
    `milestone-context:${projectId}:${milestoneId}`,
    () =>
      request<ReconciliationContext>(
        `/projects/${projectId}/milestones/${milestoneId}/reconciliation-context`,
      ),
  );
  function clear() {
    sequence.current++;
    setTargetId(null);
    setGeneration((value) => value + 1);
    setPending(null);
    setResult(null);
    setBusy(false);
  }
  useEffect(() => {
    if (context.phase === "error" && denied(context.error)) clear();
  }, [context.phase, context.error]);
  async function check() {
    if (busy) return;
    const command = pending ?? { idempotencyKey: crypto.randomUUID() },
      turn = ++sequence.current;
    setPending(command);
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const value = await request<ReconciliationCheckResult>(
        `/projects/${projectId}/milestone-reconciliation-checks`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            milestoneId,
            ruleRevision: "milestone-required-state/v1",
            enabled: true,
            ...command,
          }),
        },
      );
      if (turn === sequence.current) {
        setResult(value);
        setPending(null);
        changed();
      }
    } catch (cause) {
      if (turn === sequence.current) {
        setError(evidenceError(cause));
        if (denied(cause)) clear();
      }
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  const target = context.last?.targets.find(
    (item) => item.targetId === targetId,
  );
  return (
    <section aria-label="Milestone consistency check">
      <LoadStatus {...context} />
      {context.last ? (
        <div hidden={!context.data}>
          <p>
            Configured states are not evidence. Bind each target explicitly,
            then configure its authority and reader access in Project evidence
            using the displayed fact key.
          </p>
          <div className="evidence-targets">
            {context.last.targets.map((item) => (
              <Button
                className="secondary"
                key={item.targetId}
                onClick={() => {
                  setTargetId(item.targetId);
                  setGeneration((value) => value + 1);
                }}
              >
                {item.targetKind} {item.targetId}
              </Button>
            ))}
          </div>
          {target?.binding ? (
            <p>
              Bound fact key: <code>{target.binding.factType}</code>. Use
              Project evidence below for history, explicit authority and source
              sharing.
            </p>
          ) : target && context.last.canAppend ? (
            <BindingForm
              key={`${target.targetId}:${generation}`}
              projectId={projectId}
              request={request}
              target={target}
              onSaved={() => {
                setGeneration((value) => value + 1);
                void context.refresh();
              }}
              onDenied={clear}
            />
          ) : null}
          {context.last.canAppend ? (
            <Button disabled={busy} onClick={() => void check()}>
              {busy
                ? "Checking…"
                : pending
                  ? "Retry same milestone check"
                  : "Check milestone and request reconciliation"}
            </Button>
          ) : null}
          {error ? <Message error>{error}</Message> : null}
          {result ? (
            <div role="status">
              <p>
                Check outcome:{" "}
                {result.assessment.visibility === "available"
                  ? result.assessment.result.status
                  : "Proof restricted"}{" "}
                · {result.outcome}. A negative check does not verify completion
                or close an existing request.
              </p>
              {result.request ? (
                <>
                  <Assignment item={result.request} />
                  <p>
                    Saved link for the assigned PM (opening it requires their
                    current access):{" "}
                    <code>
                      {savedReconciliationLink(projectId, result.request.id)}
                    </code>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Queue({
  projectId,
  request,
  open,
  refreshGeneration,
}: BaseProps & { open: (id: string) => void; refreshGeneration: number }) {
  const [mode, setMode] = useState<"recipient" | "manage">("recipient"),
    [after, setAfter] = useState<ReconciliationPage["next"]>(null),
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
    `reconciliation-queue:${projectId}:${mode}:${query}:${refreshGeneration}`,
    () =>
      request<ReconciliationPage>(
        `/projects/${projectId}/reconciliation-requests${mode === "manage" ? "/manage" : ""}${query}`,
      ),
    `reconciliation-queue:${projectId}:${mode}`,
  );
  useEffect(() => {
    if (queue.phase === "error" && denied(queue.error)) {
      sequence.current++;
      setPending(null);
      setBusy(false);
    }
  }, [queue.phase, queue.error]);
  async function refreshAssignment(item: ReconciliationRequestSummary) {
    if (busy) return;
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
      await request<ReconciliationAssignmentResult>(
        `/projects/${projectId}/reconciliation-requests/${command.requestId}/assignment`,
        { method: "POST", body: JSON.stringify({ projectId, ...command }) },
      );
      if (turn === sequence.current) {
        setPending(null);
        void queue.refresh();
      }
    } catch (cause) {
      if (turn === sequence.current) {
        setError(evidenceError(cause));
        if (denied(cause)) setPending(null);
      }
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Reconciliation queue">
      <h3>Pending requests</h3>
      <SelectField
        label="Reconciliation queue"
        disabled={busy || pending !== null}
        value={mode}
        onChange={(event) => {
          sequence.current++;
          setMode(event.target.value as typeof mode);
          setAfter(null);
          setPending(null);
          setBusy(false);
          setError("");
        }}
      >
        <option value="recipient">My assigned PM requests</option>
        <option value="manage">Manage project requests</option>
      </SelectField>
      <Button
        className="secondary"
        onClick={() => {
          setAfter(null);
          void queue.refresh();
        }}
      >
        Refresh pending requests
      </Button>
      <p>
        Live queue: return to the first page to see new requests or assignment
        changes. Assignment refresh uses only the single configured PM and
        current scope; it does not choose another person or share evidence.
      </p>
      <LoadStatus {...queue} />
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
          Discard assignment retry and reload
        </Button>
      ) : null}
      {queue.data ? (
        <>
          {queue.data.requests.length === 0 ? (
            <p>No pending requests on this page.</p>
          ) : null}
          {queue.data.requests.map((item) => (
            <article className="evidence-entry" key={item.id}>
              <p>
                Milestone {item.milestoneId} · Created {item.createdAt}
              </p>
              <Assignment item={item} />
              {mode === "recipient" ? (
                <Button onClick={() => open(item.id)}>Open request</Button>
              ) : null}
              {mode === "manage" ? (
                <Button
                  className="secondary"
                  disabled={
                    busy || (!!pending && pending.requestId !== item.id)
                  }
                  onClick={() => void refreshAssignment(item)}
                >
                  {pending?.requestId === item.id
                    ? "Retry same assignment refresh"
                    : "Refresh configured PM assignment"}
                </Button>
              ) : null}
            </article>
          ))}
          {after ? (
            <Button onClick={() => setAfter(null)}>First request page</Button>
          ) : null}
          {queue.data.next ? (
            <Button onClick={() => setAfter(queue.data!.next)}>
              Next request page
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function MilestoneReconciliation({
  projectId,
  request,
  initialRequestId,
  visible = true,
}: BaseProps & { initialRequestId?: string | null; visible?: boolean }) {
  const [milestoneId, setMilestoneId] = useState<string | null>(null),
    [requestId, setRequestId] = useState(initialRequestId ?? null),
    [generation, setGeneration] = useState(0),
    [queueGeneration, setQueueGeneration] = useState(0);
  const canonical = useEvidenceResource(
    `reconciliation-canonical:${projectId}`,
    () => request<CanonicalProjectDetail>(`/projects/${projectId}/canonical`),
  );
  useEffect(() => {
    if (canonical.phase === "error" && denied(canonical.error)) {
      setMilestoneId(null);
      setRequestId(null);
      setGeneration((value) => value + 1);
    }
  }, [canonical.phase, canonical.error]);
  return (
    <section
      className="panel project-evidence"
      aria-label="Milestone reconciliation"
    >
      <h2>Milestone reconciliation</h2>
      <p>
        Retain conflicting evidence and route an internal request to the
        configured PM. No messages, approvals or source changes are performed.
      </p>
      <LoadStatus {...canonical} />
      {canonical.last ? (
        <div hidden={!visible || !canonical.data}>
          <SelectField
            label="Milestone to check"
            value={milestoneId ?? ""}
            onChange={(event) => setMilestoneId(event.target.value || null)}
          >
            <option value="">Choose a milestone</option>
            {canonical.last.milestones.map((item) => (
              <option key={item.id} value={item.id}>
                {item.key} · {item.name}
              </option>
            ))}
          </SelectField>
          {milestoneId ? (
            <MilestoneCheck
              key={`${milestoneId}:${generation}`}
              projectId={projectId}
              request={request}
              milestoneId={milestoneId}
              changed={() => setQueueGeneration((value) => value + 1)}
            />
          ) : null}
          <Queue
            key={`queue:${generation}`}
            projectId={projectId}
            request={request}
            refreshGeneration={queueGeneration}
            open={(id) => {
              setRequestId(id);
              window.history.replaceState(
                {},
                "",
                savedReconciliationLink(projectId, id),
              );
            }}
          />
          {requestId ? (
            <Proof
              key={requestId}
              projectId={projectId}
              request={request}
              requestId={requestId}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
