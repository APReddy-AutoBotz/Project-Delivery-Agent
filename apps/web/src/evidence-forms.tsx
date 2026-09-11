import React, { useEffect, useRef, useState } from "react";
import type {
  HumanStatement,
  ProjectFactValue,
  AuthorityPolicyChange,
  SourceAccessView,
  SourceAccessChange,
  ActiveAuthorityPolicy,
} from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, TextField, SelectField, Message } from "./components.js";
import {
  denied,
  conflict,
  evidenceError,
  utcInstant,
  utcNow,
} from "./evidence-state.js";
import { FactValue } from "./evidence-display.js";

type WriteProps = {
  request: RequestFn;
  projectId: string;
  onSaved: () => void;
  onDenied: () => void;
};
function useReviewedWrite<T>(
  request: RequestFn,
  path: string,
  onSaved: () => void,
  onDenied: () => void,
  repeatable = true,
) {
  const [review, setReview] = useState<T | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  function discard() {
    setReview(null);
    setError("");
    setBlocked(false);
  }
  async function save() {
    if (review === null || busy || blocked) return;
    setBusy(true);
    setError("");
    try {
      await request(path, { method: "POST", body: JSON.stringify(review) });
      if (alive.current) {
        discard();
        onSaved();
      }
    } catch (cause) {
      if (alive.current) {
        setError(evidenceError(cause));
        if (!repeatable || conflict(cause)) setBlocked(true);
        if (denied(cause)) {
          discard();
          onDenied();
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { review, setReview, error, setError, busy, blocked, discard, save };
}
function WriteActions({
  state,
  label,
  onDiscard,
}: {
  state: {
    busy: boolean;
    blocked: boolean;
    error: string;
    save: () => Promise<void>;
    discard: () => void;
  };
  label: string;
  onDiscard?: () => void;
}) {
  return (
    <>
      <div className="actions">
        <Button
          className="primary"
          disabled={state.busy || state.blocked}
          onClick={() => void state.save()}
        >
          {state.error && !state.blocked
            ? "Retry same reviewed request"
            : label}
        </Button>
        <Button
          disabled={state.busy}
          className="secondary"
          onClick={() => {
            state.discard();
            onDiscard?.();
          }}
        >
          Discard review
        </Button>
      </div>
      {state.error && <Message error>{state.error}</Message>}
      {state.blocked && (
        <p className="evidence-warning">
          Reload and compare the saved state before reviewing a new change.
        </p>
      )}
    </>
  );
}
export function StatementForm({
  request,
  projectId,
  factType,
  revision,
  onSaved,
  onDenied,
}: WriteProps & { factType: string; revision: number }) {
  const [type, setType] = useState<ProjectFactValue["type"]>("text"),
    [value, setValue] = useState(""),
    [statement, setStatement] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(utcNow),
    [validUntil, setValidUntil] = useState("");
  const state = useReviewedWrite<HumanStatement>(
    request,
    `/projects/${projectId}/fact-statements`,
    () => {
      setValue("");
      setStatement("");
      onSaved();
    },
    onDenied,
  );
  function review(event: React.FormEvent) {
    event.preventDefault();
    state.setError("");
    try {
      utcInstant(effectiveAt);
      if (validUntil && utcInstant(validUntil) < effectiveAt)
        throw new Error("Validity must end at or after the effective time.");
      if (!statement.trim())
        throw new Error("Enter the original statement you are confirming.");
      let typed: ProjectFactValue;
      if (type === "number") {
        if (!value.trim() || !Number.isFinite(Number(value)))
          throw new Error("Enter a finite number.");
        typed = { type, value: Number(value) };
      } else if (type === "boolean") {
        if (!["true", "false"].includes(value))
          throw new Error("Choose true or false.");
        typed = { type, value: value === "true" };
      } else if (type === "empty") typed = { type, value: null };
      else typed = { type, value };
      state.setReview({
        projectId,
        factType,
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
        value: typed,
        effectiveAt,
        validUntil: validUntil || null,
        originalStatement: statement,
      });
    } catch (error) {
      state.setError((error as Error).message);
    }
  }
  return (
    <section className="evidence-editor" aria-label="Confirm a statement">
      <h3>Confirm a statement</h3>
      <p>
        Record what you are confirming for <strong>{factType}</strong>. This
        appends evidence; it does not change the project's dates or a
        source-system record. Your source is private until a PMO administrator
        explicitly shares it.
      </p>
      {state.review ? (
        <div className="evidence-review">
          <h4>Review human statement</h4>
          <p>
            Target: {state.review.factType} · After revision{" "}
            {state.review.expectedRevision}
          </p>
          <FactValue value={state.review.value} />
          <blockquote>{state.review.originalStatement}</blockquote>
          <p>
            Effective {state.review.effectiveAt}; valid until{" "}
            {state.review.validUntil ?? "Not specified"}.
          </p>
          <p>
            Your signed-in account and the server time will be recorded as
            confirmation. This is attribution, not source-write approval.
          </p>
          <WriteActions state={state} label="Confirm and save statement" />
        </div>
      ) : (
        <form onSubmit={review}>
          <div className="form-row">
            <SelectField
              label="Value type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as ProjectFactValue["type"]);
                setValue("");
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="date">Date</option>
              <option value="empty">Empty</option>
            </SelectField>
            {type === "boolean" ? (
              <SelectField
                label="Statement value"
                required
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">Choose a value</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </SelectField>
            ) : (
              type !== "empty" && (
                <TextField
                  label="Statement value"
                  required={type !== "text"}
                  type={
                    type === "date"
                      ? "date"
                      : type === "number"
                        ? "number"
                        : "text"
                  }
                  step={type === "number" ? "any" : undefined}
                  min={type === "date" ? "0001-01-01" : undefined}
                  max={type === "date" ? "9999-12-31" : undefined}
                  maxLength={4096}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )
            )}
          </div>
          <label>
            Original statement
            <textarea
              aria-label="Original statement"
              required
              maxLength={8192}
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
            />
          </label>
          <div className="form-row">
            <TextField
              label="Effective at (UTC)"
              required
              maxLength={24}
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
              help="YYYY-MM-DDTHH:mm:ss.sssZ"
            />
            <TextField
              label="Valid until (UTC, optional)"
              maxLength={24}
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
              help="Leave blank when no explicit deadline is known."
            />
          </div>
          <Button type="submit" className="primary">
            Review statement
          </Button>
          {state.error && <Message error>{state.error}</Message>}
        </form>
      )}
    </section>
  );
}
export function PolicyForm({
  request,
  projectId,
  factType,
  policy,
  onSaved,
  onDenied,
}: WriteProps & { factType: string; policy: ActiveAuthorityPolicy }) {
  const [mode, setMode] = useState("enable"),
    [approval, setApproval] = useState(""),
    [basis, setBasis] = useState<"effectiveAt" | "observedAt">("effectiveAt"),
    [duration, setDuration] = useState(""),
    [behavior, setBehavior] = useState<
      "RETAIN_CONFLICT" | "REQUEST_RECONCILIATION"
    >("RETAIN_CONFLICT"),
    [effectiveAt, setEffectiveAt] = useState(utcNow);
  const state = useReviewedWrite<AuthorityPolicyChange>(
    request,
    `/projects/${projectId}/authority-policies`,
    onSaved,
    onDenied,
  );
  function review(event: React.FormEvent) {
    event.preventDefault();
    state.setError("");
    try {
      utcInstant(effectiveAt);
      const durationMs = duration === "" ? null : Number(duration) * 1000;
      if (
        durationMs !== null &&
        (!Number.isSafeInteger(durationMs) || durationMs < 1)
      )
        throw new Error(
          "Enter a positive duration in seconds, with at most three decimal places.",
        );
      if (mode === "enable" && !["APPROVED", "NOT_REQUIRED"].includes(approval))
        throw new Error("Choose the required approval state.");
      state.setReview({
        projectId,
        factType,
        expectedRevision: policy.throughRevision ?? 0,
        idempotencyKey: crypto.randomUUID(),
        effectiveAt,
        definition:
          mode === "disable"
            ? null
            : {
                tiers: [
                  {
                    selectors: [
                      {
                        sourceType: "human_statement",
                        instanceId: null,
                        requiredApproval: approval as
                          | "APPROVED"
                          | "NOT_REQUIRED",
                        validity:
                          durationMs === null ? null : { basis, durationMs },
                      },
                    ],
                  },
                ],
                conflictBehavior: behavior,
              },
      });
    } catch (error) {
      state.setError((error as Error).message);
    }
  }
  return (
    <details className="evidence-editor">
      <summary>Configure authority (PMO)</summary>
      <p>
        Publish a new whole rule for this fact type. The form supports one tier
        covering all human-statement sources. Existing tiers and source-specific
        rules will be replaced by the reviewed rule.
      </p>
      <p>
        Published revision: {policy.throughRevision ?? 0}; active revision:{" "}
        {policy.event?.revision ?? "None"}. Published future revisions may not
        be active.
      </p>
      {state.review ? (
        <div className="evidence-review">
          <h4>Review authority replacement</h4>
          <p>
            Target {state.review.factType}; replacing published revision{" "}
            {state.review.expectedRevision}; effective{" "}
            {state.review.effectiveAt}.
          </p>
          {state.review.definition ? (
            <>
              <p>
                One tier · All human-statement sources · Approval{" "}
                {
                  state.review.definition.tiers[0]!.selectors[0]!
                    .requiredApproval
                }
              </p>
              <p>
                Validity:{" "}
                {state.review.definition.tiers[0]!.selectors[0]!.validity
                  ? `${state.review.definition.tiers[0]!.selectors[0]!.validity!.durationMs} ms after ${state.review.definition.tiers[0]!.selectors[0]!.validity!.basis}`
                  : "No configured duration"}
                .
              </p>
              <p>
                Conflict behavior: {state.review.definition.conflictBehavior}.
              </p>
            </>
          ) : (
            <p>
              Disable authority for subsequent captures when this revision takes
              effect.
            </p>
          )}
          <p>
            Earlier history and saved assessments remain unchanged. Human
            confirmation does not supply APPROVED status. A reconciliation
            signal does not create a PM request.
          </p>
          <WriteActions state={state} label="Publish authority rule" />
        </div>
      ) : (
        <form onSubmit={review}>
          <SelectField
            label="Authority change"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="enable">Replace with a human-statement rule</option>
            <option value="disable">Disable authority</option>
          </SelectField>
          {mode === "enable" && (
            <>
              <SelectField
                label="Required approval"
                required
                value={approval}
                onChange={(event) => setApproval(event.target.value)}
              >
                <option value="">Choose explicitly</option>
                <option value="APPROVED">
                  Approved source decision required
                </option>
                <option value="NOT_REQUIRED">
                  No separate approval required
                </option>
              </SelectField>
              <p>
                Human statements carry confirmation only. Requiring approval
                leaves them ineligible until an approved source-decision
                workflow is available.
              </p>
              <div className="form-row">
                <TextField
                  label="Validity duration (seconds, optional)"
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  help="Blank leaves freshness dependent on the statement's explicit deadline."
                />
                <SelectField
                  label="Validity starts from"
                  value={basis}
                  onChange={(event) =>
                    setBasis(event.target.value as typeof basis)
                  }
                >
                  <option value="effectiveAt">Effective time</option>
                  <option value="observedAt">Observed time</option>
                </SelectField>
              </div>
              <SelectField
                label="Conflict behavior"
                value={behavior}
                onChange={(event) =>
                  setBehavior(event.target.value as typeof behavior)
                }
              >
                <option value="RETAIN_CONFLICT">Retain conflict</option>
                <option value="REQUEST_RECONCILIATION">
                  Show reconciliation needed
                </option>
              </SelectField>
            </>
          )}
          <TextField
            label="Rule effective at (UTC)"
            required
            maxLength={24}
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
            help="YYYY-MM-DDTHH:mm:ss.sssZ"
          />
          <Button type="submit" className="primary">
            Review authority rule
          </Button>
          {state.error && <Message error>{state.error}</Message>}
        </form>
      )}
    </details>
  );
}
export function SourceAccessForm({
  request,
  projectId,
  source,
  onSaved,
  onDenied,
  onClose,
}: WriteProps & { source: SourceAccessView; onClose: () => void }) {
  const [baseline] = useState(source);
  const [readers, setReaders] = useState(() => source.readers.join("\n")),
    [sourceState, setSourceState] = useState(source.state);
  const state = useReviewedWrite<SourceAccessChange>(
    request,
    `/projects/${projectId}/fact-sources/${source.sourceId}/access`,
    onSaved,
    onDenied,
    false,
  );
  return (
    <section className="evidence-editor" aria-label="Source reader management">
      <h3>Source readers</h3>
      <p>
        Source {source.sourceId} · Editing access revision {baseline.revision}.
      </p>
      <p>
        This replaces the complete reader list and source state. Readers still
        need current project access. Account subjects must match the identity
        provider exactly.
      </p>
      {source.revision !== baseline.revision && (
        <p className="evidence-warning">
          Saved access has changed to revision {source.revision}. Close and
          reload before reviewing another replacement.
        </p>
      )}
      {state.review ? (
        <div className="evidence-review">
          <h4>Review source access replacement</h4>
          <p>
            State: {state.review.state}; replacing revision{" "}
            {state.review.expectedRevision}.
          </p>
          <p>Reader subjects: {state.review.readers.join(", ") || "None"}.</p>
          <WriteActions
            state={state}
            label="Save source access"
            onDiscard={onClose}
          />
          {state.blocked && (
            <Button onClick={onClose}>Close and reload saved access</Button>
          )}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            state.setError("");
            const subjects = readers
              .split("\n")
              .filter((line) => line.length > 0);
            if (
              subjects.length > 100 ||
              new Set(subjects).size !== subjects.length ||
              subjects.some(
                (subject) => !subject.trim() || subject.length > 256,
              )
            ) {
              state.setError(
                "Enter up to 100 distinct account subjects, one per line.",
              );
              return;
            }
            if (source.revision !== baseline.revision) {
              state.setError(
                "Close and reload the saved access before reviewing a new change.",
              );
              return;
            }
            state.setReview({
              projectId,
              sourceId: source.sourceId,
              expectedRevision: baseline.revision,
              readers: subjects,
              state: sourceState,
            });
          }}
        >
          <SelectField
            label="Source state"
            value={sourceState}
            onChange={(event) =>
              setSourceState(event.target.value as typeof sourceState)
            }
          >
            {["AVAILABLE", "REVOKED", "DELETED", "UNVERIFIABLE"].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </SelectField>
          <label>
            Reader account subjects
            <textarea
              aria-label="Reader account subjects"
              value={readers}
              maxLength={25700}
              onChange={(event) => setReaders(event.target.value)}
            />
          </label>
          <Button type="submit" className="primary">
            Review source access
          </Button>
          {state.error && <Message error>{state.error}</Message>}
        </form>
      )}
      <Button className="text-button" disabled={state.busy} onClick={onClose}>
        Close source readers
      </Button>
    </section>
  );
}
