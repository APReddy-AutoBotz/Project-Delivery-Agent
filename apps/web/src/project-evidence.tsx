import React, { useEffect, useRef, useState } from "react";
import type {
  FactCatalogue,
  FactHistoryPage,
  ActiveAuthorityPolicy,
  AssessmentDelivery,
  SourceAccessView,
} from "@pdaa/domain";
import type { RequestFn } from "./canonical-project.js";
import { Button, TextField, Message } from "./components.js";
import {
  useEvidenceResource,
  useEvidenceDenial,
  denied,
  evidenceError,
  savedEvidenceLink,
} from "./evidence-state.js";
import {
  HistoryEntry,
  AssessmentView,
  PolicyDisplay,
} from "./evidence-display.js";
import {
  StatementForm,
  PolicyForm,
  SourceAccessForm,
} from "./evidence-forms.js";

type Props = {
  projectId: string;
  request: RequestFn;
  initialAssessmentId?: string | null;
  visible?: boolean;
};
function ResourceStatus({
  phase,
  error,
  refresh,
}: {
  phase: string;
  error?: unknown;
  refresh: () => Promise<void>;
}) {
  return (
    <>
      {phase === "loading" && (
        <p role="status">Checking current evidence access…</p>
      )}
      {phase === "error" && (
        <>
          <Message error>{evidenceError(error)}</Message>
          <Button className="secondary" onClick={() => void refresh()}>
            Retry access check
          </Button>
        </>
      )}
    </>
  );
}
export function ProjectEvidence({
  projectId,
  request,
  initialAssessmentId,
  visible = true,
}: Props) {
  const [after, setAfter] = useState<string | null>(null),
    [key, setKey] = useState("project.forecast"),
    [target, setTarget] = useState<string | null>(null);
  const [assessmentId, setAssessmentId] = useState(initialAssessmentId ?? null),
    [generation, setGeneration] = useState(0);
  const catalogue = useEvidenceResource(
    `catalogue:${projectId}:${after ?? ""}`,
    () =>
      request<FactCatalogue>(
        `/projects/${projectId}/facts${after ? `?afterFactType=${encodeURIComponent(after)}` : ""}`,
      ),
    `catalogue:${projectId}`,
  );
  const canAppend = catalogue.last?.canAppend ?? false,
    canConfigure = catalogue.last?.canConfigure ?? false;
  useEffect(() => {
    if (catalogue.phase === "error" && denied(catalogue.error)) {
      setTarget(null);
      setKey("");
      setAssessmentId(null);
      setGeneration((value) => value + 1);
    }
  }, [catalogue.phase, catalogue.error]);
  function clearDrafts() {
    setGeneration((value) => value + 1);
  }
  function clearDeniedTarget() {
    setTarget(null);
    setKey("");
    setAssessmentId(null);
    clearDrafts();
    void catalogue.refresh();
  }
  function captured(id: string) {
    setAssessmentId(id);
    window.history.replaceState({}, "", savedEvidenceLink(projectId, id));
  }
  return (
    <section className="panel project-evidence" aria-label="Project evidence">
      <div className="section-title">
        <h2>Project evidence</h2>
        <Button className="secondary" onClick={() => void catalogue.refresh()}>
          Refresh evidence access
        </Button>
      </div>
      <p>
        Inspect human statements and capture an assessment under an explicit
        authority rule. Each fact key belongs to this project; it does not
        verify or update a canonical date or child record.
      </p>
      <p className="muted">
        Access is rechecked every 15 seconds while visible and when you return.
        Content is hidden during checks. Saved assessments always describe their
        original capture time.
      </p>
      <ResourceStatus {...catalogue} />
      {visible && catalogue.data && (
        <>
          <div className="evidence-targets">
            {catalogue.data.facts.map((fact) => (
              <Button
                key={fact.factId}
                className="secondary"
                onClick={() => {
                  setKey(fact.factType);
                  setTarget(fact.factType);
                }}
              >
                {fact.factType} · revision {fact.revision}
              </Button>
            ))}
          </div>
          {!catalogue.data.facts.length && (
            <p>No fact types on this catalogue page.</p>
          )}
          <div className="actions">
            {after && (
              <Button onClick={() => setAfter(null)}>
                First catalogue page
              </Button>
            )}
            {catalogue.data.next && (
              <Button onClick={() => setAfter(catalogue.data!.next)}>
                Next fact types
              </Button>
            )}
          </div>
          <form
            className="evidence-target-form"
            onSubmit={(event) => {
              event.preventDefault();
              setTarget(key);
            }}
          >
            <TextField
              label="Fact type key"
              required
              maxLength={96}
              pattern="[a-z][a-z0-9_.\-]*"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              help="For example project.forecast. An unused key opens an empty history after a fresh access check."
            />
            <Button type="submit" className="primary">
              Open fact history
            </Button>
          </form>
        </>
      )}
      {catalogue.last && target && (
        <EvidenceTarget
          key={`${target}:${generation}`}
          projectId={projectId}
          factType={target}
          request={request}
          canAppend={canAppend}
          canConfigure={canConfigure}
          visible={visible && catalogue.phase === "ready"}
          onDenied={clearDeniedTarget}
          onSavedCatalogue={() => void catalogue.refresh()}
          onCapture={captured}
        />
      )}
      {catalogue.last && assessmentId && (
        <SavedAssessment
          key={assessmentId}
          projectId={projectId}
          request={request}
          assessmentId={assessmentId}
          visible={visible && catalogue.phase === "ready"}
          onRestricted={clearDrafts}
          onDenied={clearDeniedTarget}
        />
      )}
    </section>
  );
}
function SavedAssessment({
  projectId,
  request,
  assessmentId,
  visible,
  onRestricted,
  onDenied,
}: Props & {
  assessmentId: string;
  visible: boolean;
  onRestricted: () => void;
  onDenied: () => void;
}) {
  const resource = useEvidenceResource(
    `assessment:${projectId}:${assessmentId}`,
    () =>
      request<AssessmentDelivery>(
        `/projects/${projectId}/assessments/${assessmentId}`,
      ),
  );
  const wasAvailable = useRef(false),
    callback = useRef(onRestricted);
  useEvidenceDenial(resource.phase, resource.error, onDenied);
  useEffect(() => {
    callback.current = onRestricted;
  });
  useEffect(() => {
    if (resource.data) {
      if (wasAvailable.current && resource.data.visibility === "restricted")
        callback.current();
      wasAvailable.current = resource.data.visibility === "available";
    } else if (
      resource.phase === "error" &&
      denied(resource.error) &&
      wasAvailable.current
    ) {
      wasAvailable.current = false;
      callback.current();
    }
  }, [resource.data, resource.phase, resource.error]);
  return (
    <>
      <ResourceStatus {...resource} />
      {visible && resource.data && (
        <>
          <AssessmentView delivery={resource.data} projectId={projectId} />
          <p className="muted">
            Source access last checked{" "}
            {new Date(resource.checkedAt!).toISOString()}.
          </p>
          <Button className="secondary" onClick={() => void resource.refresh()}>
            Recheck saved assessment access
          </Button>
        </>
      )}
    </>
  );
}
function EvidenceTarget({
  projectId,
  factType,
  request,
  canAppend,
  canConfigure,
  visible,
  onDenied,
  onSavedCatalogue,
  onCapture,
}: Props & {
  factType: string;
  canAppend: boolean;
  canConfigure: boolean;
  visible: boolean;
  onDenied: () => void;
  onSavedCatalogue: () => void;
  onCapture: (id: string) => void;
}) {
  const [cursor, setCursor] = useState<{
      afterRevision: number;
      throughRevision: number;
    } | null>(null),
    [sourceId, setSourceId] = useState<string | null>(null),
    [generation, setGeneration] = useState(0);
  const [captureKey, setCaptureKey] = useState<string | null>(null),
    [captureBusy, setCaptureBusy] = useState(false),
    [captureError, setCaptureError] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const resource = useEvidenceResource(
    `target:${projectId}:${factType}:${JSON.stringify(cursor)}`,
    async () => {
      const prefix = `/projects/${projectId}/facts/${encodeURIComponent(factType)}`;
      const [history, policy] = await Promise.all([
        request<FactHistoryPage>(
          `${prefix}/history${cursor ? `?afterRevision=${cursor.afterRevision}&throughRevision=${cursor.throughRevision}` : ""}`,
        ),
        request<ActiveAuthorityPolicy>(`${prefix}/authority`),
      ]);
      return { history, policy };
    },
    `target:${projectId}:${factType}`,
  );
  const priorAccess = useRef(new Map<string, string>());
  useEvidenceDenial(resource.phase, resource.error, onDenied);
  useEffect(() => {
    if (!resource.data) return;
    let lost = false;
    for (const entry of resource.data.history.entries) {
      const access = `${entry.sourceAccessRevision}:${entry.visibility}`,
        previous = priorAccess.current.get(entry.sourceId);
      if (previous?.endsWith(":available") && entry.visibility === "restricted")
        lost = true;
      priorAccess.current.set(entry.sourceId, access);
    }
    if (lost) {
      setGeneration((value) => value + 1);
      setCaptureKey(null);
      setCaptureError("");
    }
  }, [resource.data]);
  const shown = visible && resource.phase === "ready",
    last = resource.last;
  async function capture() {
    if (!shown || captureBusy) return;
    const idempotencyKey = captureKey ?? crypto.randomUUID();
    setCaptureKey(idempotencyKey);
    setCaptureBusy(true);
    setCaptureError("");
    try {
      const value = await request<AssessmentDelivery>(
        `/projects/${projectId}/assessments`,
        {
          method: "POST",
          body: JSON.stringify({ projectId, factType, idempotencyKey }),
        },
      );
      if (alive.current) {
        setCaptureKey(null);
        onCapture(value.assessmentId);
      }
    } catch (error) {
      if (alive.current) {
        setCaptureError(evidenceError(error));
        if (denied(error)) onDenied();
      }
    } finally {
      if (alive.current) setCaptureBusy(false);
    }
  }
  function saved() {
    setCursor(null);
    void resource.refresh();
    onSavedCatalogue();
  }
  return (
    <div className="evidence-target">
      <h3>{shown ? `Fact: ${factType}` : "Fact history"}</h3>
      <ResourceStatus {...resource} />
      {shown && last && (
        <>
          <div className="section-title">
            <h3>Statement history</h3>
            <Button
              className="secondary"
              onClick={() => {
                setCursor(null);
                void resource.refresh();
              }}
            >
              Refresh history
            </Button>
          </div>
          <p>
            Historical page through revision {last.history.throughRevision}.
            Entries are not an assessment of current truth.
          </p>
          {!last.history.entries.length && (
            <p>No statements in this history page.</p>
          )}
          {last.history.entries.map((entry) => (
            <HistoryEntry
              key={entry.id}
              entry={entry}
              configure={canConfigure}
              onSource={setSourceId}
            />
          ))}
          <div className="actions">
            {cursor && (
              <Button onClick={() => setCursor(null)}>
                First history page
              </Button>
            )}
            {last.history.next && (
              <Button onClick={() => setCursor(last.history.next)}>
                Next history page
              </Button>
            )}
          </div>
          <PolicyDisplay policy={last.policy} />
          <Button
            className="primary"
            disabled={captureBusy || last.history.factId === null}
            onClick={() => void capture()}
          >
            {captureKey ? "Retry assessment capture" : "Capture new assessment"}
          </Button>
          {captureError && <Message error>{captureError}</Message>}
        </>
      )}
      {last && (
        <div hidden={!shown} aria-hidden={!shown}>
          <fieldset
            disabled={!shown || captureBusy}
            className="evidence-form-group"
          >
            {canAppend && (
              <StatementForm
                key={`statement:${generation}`}
                projectId={projectId}
                factType={factType}
                revision={last.history.throughRevision}
                request={request}
                onSaved={saved}
                onDenied={onDenied}
              />
            )}
            {canConfigure && (
              <PolicyForm
                key={`policy:${generation}`}
                projectId={projectId}
                factType={factType}
                policy={last.policy}
                request={request}
                onSaved={saved}
                onDenied={onDenied}
              />
            )}
          </fieldset>
        </div>
      )}
      {last && canConfigure && sourceId && (
        <SourceEditor
          key={sourceId}
          projectId={projectId}
          request={request}
          sourceId={sourceId}
          visible={shown}
          onDenied={onDenied}
          onClose={() => {
            setSourceId(null);
            void resource.refresh();
          }}
        />
      )}
    </div>
  );
}
function SourceEditor({
  projectId,
  request,
  sourceId,
  visible,
  onDenied,
  onClose,
}: Props & {
  sourceId: string;
  visible: boolean;
  onDenied: () => void;
  onClose: () => void;
}) {
  const resource = useEvidenceResource(`source:${projectId}:${sourceId}`, () =>
    request<SourceAccessView>(
      `/projects/${projectId}/fact-sources/${sourceId}/access`,
    ),
  );
  useEvidenceDenial(resource.phase, resource.error, onDenied);
  return (
    <>
      <ResourceStatus {...resource} />
      {resource.last && (
        <div hidden={!visible || resource.phase !== "ready"}>
          <fieldset
            className="evidence-form-group"
            disabled={!visible || resource.phase !== "ready"}
          >
            <SourceAccessForm
              projectId={projectId}
              source={resource.last}
              request={request}
              onSaved={onClose}
              onDenied={onDenied}
              onClose={onClose}
            />
          </fieldset>
        </div>
      )}
    </>
  );
}
