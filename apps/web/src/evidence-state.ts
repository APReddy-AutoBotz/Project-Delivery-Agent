import { useCallback, useEffect, useRef, useState } from "react";

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
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const sequence = useRef(0);
  const [state, setState] = useState<{
    key: string;
    scope: string;
    phase: "loading" | "ready" | "error";
    last?: T;
    error?: unknown;
    checkedAt?: number;
  }>({ key, scope, phase: "loading" });
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setState((prior) => ({
      key,
      scope,
      phase: "loading",
      ...(prior.scope === scope ? { last: prior.last } : {}),
    }));
    try {
      const value = await loader.current();
      if (current === sequence.current)
        setState({
          key,
          scope,
          phase: "ready",
          last: value,
          checkedAt: Date.now(),
        });
    } catch (error) {
      if (current === sequence.current)
        setState((prior) => ({
          key,
          scope,
          phase: "error",
          error,
          ...(denied(error) ? {} : { last: prior.last }),
        }));
    }
  }, [key, scope]);
  useEffect(() => {
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
  }, [refresh]);
  const current =
    state.key === key
      ? state
      : {
          key,
          scope,
          phase: "loading" as const,
          ...(state.scope === scope ? { last: state.last } : {}),
        };
  return {
    ...current,
    data: current.phase === "ready" ? current.last : undefined,
    refresh,
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
