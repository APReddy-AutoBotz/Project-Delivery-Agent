import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// SEC-AUTH-001: selected-project evidence keeps local draft state while its
// parent closes admission, then obtains fresh evidence on readmission.
const unrestrictedAdmission = Object.freeze({});
export const EvidenceAdmissionContext = createContext<object | null>(unrestrictedAdmission);

export const denied = (error: unknown) =>
  [401, 403, 404].includes((error as { status?: number })?.status ?? 0);
export const conflict = (error: unknown) =>
  (error as { status?: number })?.status === 409;
export const evidenceError = (error: unknown) =>
  denied(error)
    ? "This evidence or action is unavailable for your account. Refresh to check current access."
    : conflict(error)
      ? "The saved revision or request has changed. Refresh and review before making a new change."
      : "The request could not be confirmed. Check your connection and retry the same reviewed request.";

export function useEvidenceDenial(
  phase: string,
  error: unknown,
  onDenied: () => void,
) {
  const callback = useRef(onDenied);
  useEffect(() => {
    callback.current = onDenied;
  });
  useEffect(() => {
    if (phase === "error" && denied(error)) callback.current();
  }, [phase, error]);
}

// FR-EVD-009 / NFR-SEC-001: no persistent client cache. Previous content is hidden
// during every current-authorization check; stale responses cannot cross scopes.
export function useEvidenceResource<T>(
  key: string,
  load: () => Promise<T>,
  scope = key,
) {
  const admission = useContext(EvidenceAdmissionContext);
  const admissionRef = useRef(admission); admissionRef.current = admission;
  const keyRef = useRef(key), scopeRef = useRef(scope); keyRef.current = key; scopeRef.current = scope;
  const ownerRef = useRef({ key, scope, admission, id: Symbol("evidence-owner") });
  if (ownerRef.current.key !== key || ownerRef.current.scope !== scope || ownerRef.current.admission !== admission)
    ownerRef.current = { key, scope, admission, id: Symbol("evidence-owner") };
  const owner = ownerRef.current.id;
  const retentionRef = useRef({ scope, id: Symbol("evidence-retention") });
  if (retentionRef.current.scope !== scope) retentionRef.current = { scope, id: Symbol("evidence-retention") };
  const retention = retentionRef.current.id;
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const sequence = useRef(0);
  const [state, setState] = useState<{
    key: string;
    scope: string;
    phase: "loading" | "ready" | "error";
    admission: object | null;
    sequence: number;
    owner: symbol;
    retention: symbol;
    last?: T;
    error?: unknown;
    checkedAt?: number;
  }>({ key, scope, phase: "loading", admission: null, sequence: 0, owner, retention });
  const stateRef = useRef(state); stateRef.current = state;
  const renderedAdmission = admission, renderedSequence = state.sequence;
  const isCurrent = () => Boolean(renderedAdmission && ownerRef.current.id === owner && admissionRef.current === renderedAdmission &&
    keyRef.current === key && scopeRef.current === scope && stateRef.current.admission === renderedAdmission && stateRef.current.owner === owner &&
    stateRef.current.key === key && stateRef.current.scope === scope &&
    stateRef.current.phase === "ready" && stateRef.current.sequence === renderedSequence && sequence.current === renderedSequence);
  const refresh = useCallback(async () => {
    const ticket = admission;
    if (!ticket || ownerRef.current.id !== owner || admissionRef.current !== ticket || keyRef.current !== key || scopeRef.current !== scope) return;
    const current = ++sequence.current;
    setState((prior) => ({
      key,
      scope,
      phase: "loading",
      admission: ticket,
      sequence: current,
      owner, retention,
      // Same-owner retained values keep hidden draft owners mounted; only
      // `data` from this admission is presented as current evidence.
      ...(prior.retention === retention ? { last: prior.last } : {}),
    }));
    try {
      const value = await loader.current();
      if (current === sequence.current && ownerRef.current.id === owner && admissionRef.current === ticket && keyRef.current === key && scopeRef.current === scope)
        setState({
          key,
          scope,
          phase: "ready",
          admission: ticket,
          sequence: current,
          owner, retention,
          last: value,
          checkedAt: Date.now(),
        });
    } catch (error) {
      if (current === sequence.current && ownerRef.current.id === owner && admissionRef.current === ticket && keyRef.current === key && scopeRef.current === scope)
        setState((prior) => ({
          key,
          scope,
          phase: "error",
          admission: ticket,
          sequence: current,
          owner, retention,
          error,
          ...(denied(error) || prior.retention !== retention ? {} : { last: prior.last }),
        }));
    }
  }, [key, scope, admission, owner, retention]);
  useEffect(() => {
    if (!admission) return;
    void refresh();
    const revalidate = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(revalidate, 15000);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      ++sequence.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh, admission]);
  const current: typeof state =
    admission && state.admission === admission && state.owner === owner && state.key === key && state.scope === scope
      ? state
      : {
          key,
          scope,
          phase: "loading" as const,
          admission,
          sequence: sequence.current,
          owner, retention,
          ...(state.retention === retention ? { last: state.last } : {}),
        };
  return {
    ...current,
    data: current.phase === "ready" ? current.last : undefined,
    refresh,
    isCurrent,
  };
}

export const utcNow = () => new Date().toISOString();
export function utcInstant(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    value.startsWith("0000-")
  )
    throw new Error("Enter a complete UTC time, including milliseconds and Z.");
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Enter a valid UTC time.");
  return value;
}
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function savedEvidenceLink(projectId: string, assessmentId: string) {
  return `/?project=${encodeURIComponent(projectId)}&assessment=${encodeURIComponent(assessmentId)}`;
}
