import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type { RequestFn } from "./request-types.js";
import { establishHealthScope, sameHealthRoles } from "./health-scope-coordinator.js";
import { HealthScopeFence, type HealthReadTicket, type HealthWriteLease } from "./health-scope-fence.js";
import { managedRead } from "./managed-read.js";
import { policyRevisionMatches, type PolicyAdmission } from "./health-policy-admission.js";
import { decodeWireIdentity } from "./identity-decoder.js";

type Owner = {
  ready: boolean;
  writing: boolean;
  reading: boolean;
  canWrite: boolean;
  uncertain: boolean;
  failed: boolean;
  networkLimited: boolean;
  atCapacity: boolean;
  pendingAssessment: boolean;
  assessmentCapacity: boolean;
  key: readonly unknown[];
  current(): boolean;
  refresh(): void;
  recheck(): void;
  reserveRead(): { current(): boolean; release(): void } | null;
  read<T>(path: string, signal: AbortSignal, maxResponseBytes?: number | null, onUnavailable?: (denied?: boolean) => void): Promise<T>;
  beginWrite(policy: PolicyAdmission): HealthWriteLease | null;
  beginAssessment(): { lease: HealthWriteLease; key: string } | null;
  startAssessment(lease: HealthWriteLease, key: string): boolean;
  abandonUnsentAssessment(lease: HealthWriteLease): void;
  completeAssessment(lease: HealthWriteLease, key: string): void;
  write<T>(lease: HealthWriteLease, path: string, init: RequestInit, expectedStatus?: number): Promise<T>;
  writeCurrent(lease: HealthWriteLease): boolean;
  markWriteUncertain(lease: HealthWriteLease): void;
  finishWrite(lease: HealthWriteLease): void;
};
type Identity = { customerId: string; subject: string; roles: string[] };
const Context = createContext<Owner | null>(null);
const unavailable = () => new Error("Health access is being checked. Refresh before trying again.");

export function HealthScopeProvider({ fence, actor, projectId, session, request, visible, isCurrent, children }: {
  fence: HealthScopeFence; actor: Identity; projectId: string; session: number; request: RequestFn;
  visible: boolean; isCurrent: () => boolean; children: React.ReactNode;
}) {
  useSyncExternalStore(fence.subscribe, fence.snapshot, fence.snapshot);
  const networkRevision = useSyncExternalStore(fence.managedReads.subscribe, fence.managedReads.snapshot, fence.managedReads.snapshot);
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  const context = fence.contextSnapshot();
  const currentRef = useRef(isCurrent); currentRef.current = isCurrent;
  const roles = [...actor.roles].sort();
  const rolesKey = JSON.stringify(roles);
  // Stable within this browser tab for the same principal, including across
  // role/session changes; never placed in a query key or browser storage.
  const ownerKey = JSON.stringify([actor.customerId, actor.subject]);
  const scopeKey = JSON.stringify([session, actor.customerId, actor.subject, roles, projectId]);
  // Allow the expected view batch to start together; otherwise repeated
  // whole-scope retries could keep discarding partial successes indefinitely.
  const requiredSlots = 2 + (roles.includes("pmo_admin") ? 2 : 0) + (roles.includes("leadership") ? 1 : 0);

  useEffect(() => {
    if (!visible || !currentRef.current()) return;
    if (fence.bindScope(scopeKey) || fence.denialLatched()) return;
    const controller = new AbortController();
    const current = () => fence.contextSnapshot() === context && currentRef.current();
    if (fence.managedReads.available() < requiredSlots) { fence.capacityFailure(context, current); return; }
    const scopedCheck = <T,>(path: string, signal: AbortSignal, checkCurrent: () => boolean) =>
      managedRead(fence.managedReads, signal, checkCurrent, (live, completion) =>
        request<T>(path, {}, 65_536,
          (denied) => { if (denied && live()) fence.denyContext(context, current); },
          { current: live, completion }, undefined, path === "/me" ? 200 : undefined));
    void establishHealthScope(fence, context, current, controller.signal,
      async (signal, checkCurrent) => {
        if (!current()) return false;
        const actual = decodeWireIdentity(await scopedCheck<unknown>("/me", signal, checkCurrent));
        return current() && checkCurrent() && Boolean(actual && actual.customerId === actor.customerId && actual.subject === actor.subject && sameHealthRoles(actual.roles, roles));
      },
      async (signal, checkCurrent) => {
        if (!current()) return false;
        const actual = await scopedCheck<{ id: string }>("/projects/" + projectId, signal, checkCurrent);
        return current() && actual.id === projectId;
      });
    return () => controller.abort();
  }, [fence, context, visible, actor.customerId, actor.subject, rolesKey, scopeKey, requiredSlots, projectId, session, request]);

  const baseCurrent = () => visible && fence.contextSnapshot() === context && currentRef.current();
  const ticket = fence.capture(baseCurrent);
  const owner = useMemo<Owner>(() => {
    const valid = (candidate: HealthReadTicket | null): candidate is HealthReadTicket =>
      candidate !== null && fence.valid(candidate, baseCurrent);
    const queryScope = [session, actor.customerId, actor.subject, roles, projectId, ticket?.context ?? context, ticket?.view ?? -1] as const;
    // Inspect query state synchronously at action dispatch, including the
    // interval before a newly enabled query function registers its read.
    const writesAdmitted = () => {
      const keys = ["health-assessment-latest", "canonical-project"];
      if (roles.includes("pmo_admin")) keys.push("blocker-age-threshold-policy", "schedule-health-policy");
      return keys.every((name) => {
        const state = queryClient.getQueryState([name, ...queryScope]);
        return Boolean(state && state.status === "success" && state.fetchStatus === "idle");
      });
    };
    return {
      ready: ticket !== null,
      writing: fence.writing(),
      reading: fence.reading(),
      canWrite: valid(ticket) && !fence.reading() && writesAdmitted(),
      uncertain: fence.uncertain(ownerKey),
      failed: fence.checkFailed(),
      networkLimited: fence.managedReads.available() < requiredSlots,
      atCapacity: fence.atCapacity(ownerKey),
      pendingAssessment: fence.hasAssessmentCommand(ownerKey, projectId),
      assessmentCapacity: fence.assessmentCapacity(ownerKey, projectId),
      key: queryScope,
      current: () => valid(ticket),
      refresh: () => { if (valid(ticket) && fence.managedReads.available() >= requiredSlots) fence.refreshReads(); },
      recheck: () => { if (baseCurrent() && fence.managedReads.available() >= requiredSlots) fence.retryScope(); },
      reserveRead: () => {
        if (!valid(ticket)) return null;
        const read = fence.trackRead(ticket, baseCurrent);
        return read ? { current: () => !read.signal.aborted && valid(ticket), release: read.release } : null;
      },
      async read<T>(path: string, signal: AbortSignal, maxResponseBytes: number | null = 1_048_576, onUnavailable?: (denied?: boolean) => void): Promise<T> {
        if (!valid(ticket)) throw unavailable();
        const read = fence.trackRead(ticket, baseCurrent);
        if (!read) throw unavailable();
        const controller = new AbortController();
        // Logical cancellation stops blocking actions immediately. The
        // managed physical slot remains occupied until its own completion.
        const abort = () => { controller.abort(); read.release(); };
        signal.addEventListener("abort", abort, { once: true });
        read.signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || read.signal.aborted) abort();
        try {
          if (!valid(ticket) || controller.signal.aborted) throw unavailable();
          const result = await managedRead(fence.managedReads, controller.signal, () => valid(ticket), (live, completion) =>
            request<T>(path, {}, maxResponseBytes ?? undefined, (denied) => {
              if (!live()) return;
              if (denied) fence.denyContext(context, baseCurrent);
              else onUnavailable?.(denied);
            }, { current: live, completion }));
          if (!valid(ticket)) throw unavailable();
          return result;
        } finally {
          signal.removeEventListener("abort", abort); read.signal.removeEventListener("abort", abort); read.release();
        }
      },
      // This is an admission guard for the fixed policy callers, not an API
      // authorization boundary. The server checks the actual request.
      beginWrite: (policy) => valid(ticket) ? fence.beginWrite(ticket, baseCurrent, ownerKey, () => {
        if (!roles.includes("pmo_admin") || !writesAdmitted() || !policy) return false;
        const name = policy.kind === "threshold" ? "blocker-age-threshold-policy" : policy.kind === "schedule" ? "schedule-health-policy" : null;
        return name !== null && policyRevisionMatches(policy, queryClient.getQueryState([name, ...queryScope]));
      }) : null,
      beginAssessment: () => {
        try { return valid(ticket) ? fence.beginAssessment(ticket, baseCurrent, ownerKey, projectId, () => crypto.randomUUID(), writesAdmitted) : null; }
        catch { return null; }
      },
      startAssessment: (lease, key) => fence.startAssessment(lease, baseCurrent, projectId, key),
      abandonUnsentAssessment: (lease) => fence.abandonUnsentAssessment(lease),
      completeAssessment: (lease, key) => fence.completeAssessment(lease, baseCurrent, projectId, key),
      async write<T>(lease: HealthWriteLease, path: string, init: RequestInit, expectedStatus?: number): Promise<T> {
        if (!fence.validWrite(lease, baseCurrent)) throw unavailable();
        try {
          // A write is never enrolled in the managed-read registry. Its late
          // denial still must not invalidate a different selected project.
          const result = await request<T>(path, init, 1_048_576,
            (denied) => { if (denied && fence.validWrite(lease, baseCurrent)) fence.denyContext(context, baseCurrent); }, undefined,
            () => fence.validWrite(lease, baseCurrent), expectedStatus);
          if (!fence.validWrite(lease, baseCurrent)) throw unavailable();
          return result;
        } catch { fence.markWriteUncertain(lease); throw unavailable(); }
      },
      writeCurrent: (lease) => fence.validWrite(lease, baseCurrent),
      markWriteUncertain: (lease) => fence.markWriteUncertain(lease),
      finishWrite: (lease) => fence.finishWrite(lease),
    };
  // Each fence revision re-evaluates the ticket; baseCurrent reads current refs.
  }, [fence, context, ticket?.context, ticket?.view, fence.writing(), fence.reading(), fence.uncertain(ownerKey), fence.checkFailed(), fence.hasAssessmentCommand(ownerKey, projectId), fence.assessmentCapacity(ownerKey, projectId), networkRevision, fetching, requiredSlots, session, actor.customerId, actor.subject, rolesKey, projectId, request, visible, queryClient]);
  return <Context.Provider value={owner}>{children}</Context.Provider>;
}

export function useHealthScope(): Owner {
  const value = useContext(Context);
  if (!value) throw new Error("Health scope is unavailable");
  return value;
}
