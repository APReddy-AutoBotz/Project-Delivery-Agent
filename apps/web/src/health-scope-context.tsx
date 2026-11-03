import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { RequestFn } from "./request-types.js";
import { establishHealthScope } from "./health-scope-coordinator.js";
import { HealthScopeFence, type HealthReadTicket, type HealthWriteLease } from "./health-scope-fence.js";

type Owner = {
  ready: boolean;
  writing: boolean;
  reading: boolean;
  uncertain: boolean;
  failed: boolean;
  atCapacity: boolean;
  pendingAssessment: boolean;
  assessmentCapacity: boolean;
  key: readonly unknown[];
  current(): boolean;
  refresh(): void;
  recheck(): void;
  read<T>(path: string, signal: AbortSignal, maxResponseBytes?: number | null): Promise<T>;
  beginWrite(): HealthWriteLease | null;
  assessmentCommand(): string | null;
  completeAssessment(lease: HealthWriteLease, key: string): void;
  write<T>(lease: HealthWriteLease, path: string, init: RequestInit): Promise<T>;
  writeCurrent(lease: HealthWriteLease): boolean;
  finishWrite(lease: HealthWriteLease): void;
};
type Identity = { customerId: string; subject: string; roles: string[] };
const Context = createContext<Owner | null>(null);
const unavailable = () => new Error("Health access is being checked. Refresh before trying again.");
const sameRoles = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((role, index) => role === [...b].sort()[index]);

export function HealthScopeProvider({ fence, actor, projectId, session, request, visible, isCurrent, children }: {
  fence: HealthScopeFence; actor: Identity; projectId: string; session: number; request: RequestFn;
  visible: boolean; isCurrent: () => boolean; children: React.ReactNode;
}) {
  useSyncExternalStore(fence.subscribe, fence.snapshot, fence.snapshot);
  const context = fence.contextSnapshot();
  const currentRef = useRef(isCurrent); currentRef.current = isCurrent;
  const roles = [...actor.roles].sort();
  const rolesKey = JSON.stringify(roles);
  // Stable within this browser tab for the same principal, including across
  // role/session changes; never placed in a query key or browser storage.
  const ownerKey = JSON.stringify([actor.customerId, actor.subject]);

  useEffect(() => {
    if (!visible || !currentRef.current()) return;
    const controller = new AbortController();
    const current = () => fence.contextSnapshot() === context && currentRef.current();
    void establishHealthScope(fence, context, current, controller.signal,
      async (signal) => {
        if (!current()) return false;
        const actual = await request<Identity>("/me", { signal }, 65_536);
        return current() && actual.customerId === actor.customerId && actual.subject === actor.subject && sameRoles(actual.roles, roles);
      },
      async (signal) => {
        if (!current()) return false;
        const actual = await request<{ id: string }>("/projects/" + projectId, { signal }, 65_536);
        return current() && actual.id === projectId;
      });
    return () => controller.abort();
  }, [fence, context, visible, actor.customerId, actor.subject, rolesKey, projectId, session, request]);

  const baseCurrent = () => visible && fence.contextSnapshot() === context && currentRef.current();
  const ticket = fence.capture(baseCurrent);
  const owner = useMemo<Owner>(() => {
    const valid = (candidate: HealthReadTicket | null): candidate is HealthReadTicket =>
      candidate !== null && fence.valid(candidate, baseCurrent);
    return {
      ready: ticket !== null,
      writing: fence.writing(),
      reading: fence.reading(),
      uncertain: fence.uncertain(ownerKey),
      failed: fence.checkFailed(),
      atCapacity: fence.atCapacity(ownerKey),
      pendingAssessment: fence.hasAssessmentCommand(ownerKey, projectId),
      assessmentCapacity: fence.assessmentCapacity(ownerKey, projectId),
      key: [session, actor.customerId, actor.subject, roles, projectId, ticket?.context ?? context, ticket?.view ?? -1],
      current: () => valid(ticket),
      refresh: () => { if (valid(ticket)) fence.refreshReads(); },
      recheck: () => { if (baseCurrent()) fence.transition(true); },
      async read<T>(path: string, signal: AbortSignal, maxResponseBytes: number | null = 1_048_576): Promise<T> {
        if (!valid(ticket)) throw unavailable();
        const read = fence.trackRead(ticket, baseCurrent);
        if (!read) throw unavailable();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        read.signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || read.signal.aborted) controller.abort();
        try {
          if (!valid(ticket) || controller.signal.aborted) throw unavailable();
          const result = await request<T>(path, { signal: controller.signal }, maxResponseBytes ?? undefined);
          if (!valid(ticket)) throw unavailable();
          return result;
        } finally {
          signal.removeEventListener("abort", abort); read.signal.removeEventListener("abort", abort); read.release();
        }
      },
      beginWrite: () => valid(ticket) ? fence.beginWrite(ticket, baseCurrent, ownerKey) : null,
      assessmentCommand: () => {
        try { return valid(ticket) ? fence.assessmentCommand(ticket, baseCurrent, ownerKey, projectId, () => crypto.randomUUID()) : null; }
        catch { return null; }
      },
      completeAssessment: (lease, key) => fence.completeAssessment(lease, baseCurrent, projectId, key),
      async write<T>(lease: HealthWriteLease, path: string, init: RequestInit): Promise<T> {
        if (!fence.validWrite(lease, baseCurrent)) throw unavailable();
        try {
          const result = await request<T>(path, init, 1_048_576);
          if (!fence.validWrite(lease, baseCurrent)) throw unavailable();
          return result;
        } catch { fence.markWriteUncertain(lease); throw unavailable(); }
      },
      writeCurrent: (lease) => fence.validWrite(lease, baseCurrent),
      finishWrite: (lease) => fence.finishWrite(lease),
    };
  // Each fence revision re-evaluates the ticket; baseCurrent reads current refs.
  }, [fence, context, ticket?.context, ticket?.view, fence.writing(), fence.reading(), fence.uncertain(ownerKey), fence.checkFailed(), fence.hasAssessmentCommand(ownerKey, projectId), fence.assessmentCapacity(ownerKey, projectId), session, actor.customerId, actor.subject, rolesKey, projectId, request, visible]);
  return <Context.Provider value={owner}>{children}</Context.Provider>;
}

export function useHealthScope(): Owner {
  const value = useContext(Context);
  if (!value) throw new Error("Health scope is unavailable");
  return value;
}
