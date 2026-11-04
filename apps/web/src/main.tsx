import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { Button, TextField, SelectField, Message } from "./components.js";
import {
  CreateProject,
  CanonicalProjectDetails,
  type ProjectSetup,
} from "./canonical-project.js";
import "./style.css";
import "./access-grant.css";
import { ProjectEvidence } from "./project-evidence.js";
import { HealthAssessmentPanel } from "./health-assessment.js";
import { HealthScopeFence } from "./health-scope-fence.js";
import { HealthScopeProvider } from "./health-scope-context.js";
import { DeliverySuggestions } from "./delivery-suggestions.js";
import { UpdateSuggestions } from "./update-suggestions.js";
import { LeadershipBlockerAge } from "./leadership-blocker-age.js";
import { PmActionQueuePanel } from "./pm-action-queue.js";
import { discardResponse, readBoundedJson, readCompleteJson } from "./bounded-json.js";
import { IngestionReassessmentPreview } from "./ingestion-reassessment-preview-panel.js";
import { decodeWireIdentity } from "./identity-decoder.js";
import { decodeProjectList, decodeProjectSetup } from "./canonical-creation-decoder.js";
import { ProjectUpdates } from "./project-updates.js";
import { ProjectUpdateResponse } from "./project-update-response.js";
import { CsvIngestion } from "./csv-ingestion.js";
import { savedScalarReconciliationLink } from "./scalar-reconciliation.js";
import {
  MilestoneReconciliation,
  savedReconciliationLink,
} from "./milestone-reconciliation.js";
import { uuid, savedEvidenceLink, denied, EvidenceAdmissionContext } from "./evidence-state.js";
import { bindSessionRequest } from "./session-bound-request.js";
import type { RequestFn } from "./request-types.js";
import { projectPolicyOwner } from "./project-policy-write-registry.js";
import { accessGrantOwner, accessGrantWrites } from "./access-grant-write-registry.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead } from "./managed-read.js";

function evidenceLocation() {
  const query = new URLSearchParams(window.location.search);
  const projectId = query.get("project"),
    assessmentId = query.get("assessment"),
    requestId = query.get("reconciliation"),
    scalarRequestId = query.get("scalarReconciliation");
  return projectId &&
    uuid.test(projectId) &&
    [assessmentId, requestId, scalarRequestId].filter(Boolean).length === 1 &&
    [assessmentId, requestId, scalarRequestId].every(
      (value) => value === null || uuid.test(value),
    )
    ? { projectId, assessmentId, requestId, scalarRequestId }
    : null;
}

function updateRequestLocation() {
  const match = /^\/update-requests\/([0-9a-f-]{36})$/i.exec(window.location.pathname);
  return match && uuid.test(match[1]!) ? match[1]! : null;
}

type AuthConfig = {
  mode: "oidc" | "development";
  dataMode: string;
  issuer?: string;
  clientId?: string;
  scope: string;
  resource?: string;
};
type Actor = { subject: string; roles: string[]; customerId: string };
const emptyHealthActor: Actor = { subject: "", roles: [], customerId: "" };
type Project = {
  id: string;
  code: string;
  name: string;
  description: string;
  reportedStatus: string;
};
type Platform = {
  database: string;
  worker: string;
  shadowMode: boolean;
  identityMode: string;
  dataMode: string;
};
type AccessOperation = { id: string; event: "access.granted" | "access.revoked"; actor: string; occurredAt: string };
const operationUuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
function decodeAccessOperations(value: unknown): AccessOperation[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Access operation history is unavailable.");
  const rows = value.map((item: unknown): AccessOperation => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Access operation history is unavailable.");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "actor,event,id,occurredAt" ||
        typeof row.id !== "string" || !operationUuid.test(row.id) ||
        (row.event !== "access.granted" && row.event !== "access.revoked") ||
        typeof row.actor !== "string" || row.actor.length < 1 || row.actor.length > 512 ||
        typeof row.occurredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.occurredAt) ||
        !Number.isFinite(Date.parse(row.occurredAt)) || new Date(row.occurredAt).toISOString() !== row.occurredAt)
      throw new Error("Access operation history is unavailable.");
    return { id: row.id, event: row.event, actor: row.actor, occurredAt: row.occurredAt };
  });
  const ids = new Set(rows.map((row) => row.id.toLowerCase()));
  if (ids.size !== rows.length || rows.some((row, index) => {
    const previous = rows[index - 1];
    return previous && (previous.occurredAt < row.occurredAt ||
      (previous.occurredAt === row.occurredAt && previous.id.toLowerCase() <= row.id.toLowerCase()));
  })) throw new Error("Access operation history is unavailable.");
  return rows;
}
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
// App-lifetime owner: a pending local health write survives panel, project and
// session remounts. It is not a cross-tab/server write lock.
const healthFence = new HealthScopeFence();
let healthPageHidden = false;
function clearProtectedData() {
  // TR-AUTH-003 / NFR-SEC-005: keep only public bootstrap configuration. Removing
  // it starts an unnecessary refetch immediately before the logout redirect.
  client.removeQueries({
    predicate: ({ queryKey }) =>
      !(queryKey.length === 1 && queryKey[0] === "auth-config"),
  });
  client.getMutationCache().clear();
}
// Tokens live only in memory. OIDC redirect state uses session storage and is removed by the callback.
let accessToken: string | undefined;
let sessionGeneration = 0;
let idToken: string | undefined;
let oidc: UserManager | undefined;
let expireSession: ((reason?: "identity-unavailable") => void) | undefined;
function useProtectedQuery<T>(options: UseQueryOptions<T>) {
  const query = useQuery(options);
  return {
    ...query,
    lastData: query.data,
    data: query.isError ? undefined : query.data,
  };
}
async function rawRequest<T>(path: string, init: RequestInit = {}, maxResponseBytes?: number, onUnavailable: (denied?: boolean) => void = () => {}, managed?: import("./request-types.js").ManagedRequestPolicy, sideEffectCurrent?: () => boolean, expectedStatus?: number, expectedSession?: { token: string | undefined; generation: number }): Promise<T> {
  const managedCurrent = () => {
    if (!managed) return true;
    try { return managed.current() === true; } catch { return false; }
  };
  const effectsCurrent = () => {
    if (!sideEffectCurrent) return true;
    try { return sideEffectCurrent() === true; } catch { return false; }
  };
  let requestToken: string | undefined, requestGeneration: number, options: RequestInit;
  try {
    if (!managedCurrent()) throw new Error("Request is no longer current.");
    requestToken = expectedSession ? expectedSession.token : accessToken;
    requestGeneration = expectedSession ? expectedSession.generation : sessionGeneration;
    const isMultipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    options = {
      ...init,
      // Protected results are session-scoped; do not reuse an HTTP cache
      // entry across sessions, including when token text is reused.
      ...(requestToken ? { cache: "no-store" as const } : {}),
      headers: {
        ...(init.body && !isMultipart ? { "Content-Type": "application/json" } : {}),
        ...(requestToken ? { Authorization: "Bearer " + requestToken } : {}),
      },
    };
    // Request-init getters may revoke the read or change the session.
    if (!managedCurrent() || !effectsCurrent()) throw new Error("Request is no longer current.");
    if (expectedSession && (!requestToken || requestToken !== accessToken || requestGeneration !== sessionGeneration))
      throw new Error("The session changed before this request started.");
  } catch (error) {
    // No fetch was invoked and no original response exists to drain.
    try { managed?.completion("terminated"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
  const response = await fetch("/api" + path, options);
  // FR-EVD-009 / SEC-SECRET-001: consume discarded bodies on early exits, too.
  // Start the reader before throwing, but never delay a known denial/session
  // clear on body delivery. The recorder independently requires complete bytes.
  const sessionCurrent = () => !requestToken || (requestToken === accessToken && requestGeneration === sessionGeneration);
  const stale = !sessionCurrent();
  // The issuing session is checked before invoking any scoped predicate.
  if (response.status === 401 && requestToken && sessionCurrent()) expireSession?.();
  // Snapshot scoped eligibility before a denial callback or invalidation can
  // synchronously advance the scope. Session expiry remains token/generation
  // based even when a project-specific request has become obsolete.
  const currentAtHeaders = !stale && managedCurrent() && effectsCurrent() && sessionCurrent();
  const unexpectedStatus = response.ok && expectedStatus !== undefined && response.status !== expectedStatus;
  if (!response.ok || stale || unexpectedStatus) {
    const denied = currentAtHeaders && (response.status === 403 || response.status === 404);
    if (managed && currentAtHeaders && response.status !== 401) {
      try { onUnavailable(denied); } catch { /* An unavailable response still drains. */ }
    }
    if (!managed && maxResponseBytes !== undefined && currentAtHeaders) {
      try { onUnavailable(denied); } catch { /* A denial still clears the response. */ }
    }
    // Denial deliberately invalidates the managed ticket. List admission is
    // session-wide, so retain header eligibility while rechecking the session.
    if (denied && path.startsWith("/projects/") && sessionCurrent())
      void client.invalidateQueries({ queryKey: ["projects"] });
    if (maxResponseBytes !== undefined || managed) {
      await discardResponse(response, managed?.completion);
    } else void response.arrayBuffer().catch(() => {});
  }
  if (stale)
    throw new Error("The session changed before this request completed.");
  if (unexpectedStatus) throw new Error("The request outcome could not be confirmed.");
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 401
          ? "Your session has ended. Sign out and sign in again."
          : response.status === 404
            ? "This project is unavailable for your account."
            : response.status === 403
              ? "You do not have permission for this action."
              : response.status === 409
                ? "This code, source reference or request conflicts with an existing record. Review the details before submitting again."
                : response.status === 400
                  ? "Some project details are invalid. Check the required fields, dates and references."
                  : "The request could not be completed. Please try again.",
      ),
      { status: response.status },
    );
  let data: unknown;
  if (response.status === 204) { managed?.completion("terminated"); data = undefined; }
  else if (maxResponseBytes === undefined) {
    data = managed ? await readCompleteJson(response, managed.completion) : await response.json();
  } else {
    data = await readBoundedJson(response, maxResponseBytes,
      () => { if (managedCurrent() && effectsCurrent() && sessionCurrent()) onUnavailable(); }, managed?.completion);
  }
  if (requestToken && (requestToken !== accessToken || requestGeneration !== sessionGeneration))
    throw new Error("The session changed before this request completed.");
  return data as T;
}
function manager(config: AuthConfig) {
  if (oidc) return oidc;
  oidc = new UserManager({
    authority: config.issuer!,
    client_id: config.clientId!,
    redirect_uri: window.location.origin + "/auth/callback",
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: config.scope,
    resource: config.resource,
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({
      store: {
        get length() {
          return 0;
        },
        clear() {},
        getItem() {
          return null;
        },
        key() {
          return null;
        },
        removeItem() {},
        setItem() {},
      },
    }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  });
  // NFR-SEC-005: expiry clears protected views/drafts without waiting for the
  // next API request. Identity validation remains exclusively server enforced.
  oidc.events.addAccessTokenExpired(() => expireSession?.());
  return oidc;
}
function App() {
  const pmPreviewInvalidate = React.useRef<(() => void) | null>(null);
  const reassessmentInvalidate = React.useRef<(() => void) | null>(null), reassessmentScope = React.useRef(0);
  const [, refreshReassessmentScope] = React.useReducer((value: number) => value + 1, 0);
  const renderedReassessmentScope = reassessmentScope.current;
  const invalidateReassessment = () => { reassessmentScope.current++; reassessmentInvalidate.current?.(); refreshReassessmentScope(); };
  const renderedSessionGeneration = sessionGeneration, renderedSessionToken = accessToken;
  const request = React.useMemo(() => {
    const boundRaw: RequestFn = <T,>(...args: Parameters<RequestFn>) => rawRequest<T>(...args,
      { token: renderedSessionToken, generation: renderedSessionGeneration });
    return bindSessionRequest(boundRaw, () => Boolean(renderedSessionToken &&
      accessToken === renderedSessionToken && sessionGeneration === renderedSessionGeneration));
  }, [renderedSessionToken, renderedSessionGeneration]);
  const isCurrentPreviewSession = React.useCallback(() => Boolean(renderedSessionToken && accessToken === renderedSessionToken &&
    sessionGeneration === renderedSessionGeneration), [renderedSessionToken, renderedSessionGeneration]);
  const healthVisible = () => Boolean(accessToken && !healthPageHidden && document.visibilityState === "visible");
  const healthTransition = () => healthFence.transition(healthVisible());
  const advanceSession = () => { sessionGeneration++; healthFence.switchScope(healthVisible()); pmPreviewInvalidate.current?.(); invalidateReassessment(); };
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const queueViewRevisionRef = React.useRef(0);
  const [queueViewRevision, setQueueViewRevision] = useState(0);
  const advanceQueueView = () => { queueViewRevisionRef.current++; setQueueViewRevision(queueViewRevisionRef.current); };
  const [view, setView] = useState<"projects" | "platform" | "ingestion">("projects");
  const viewRef = React.useRef<"projects" | "platform" | "ingestion">("projects");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = React.useRef<string | null>(null);
  const selectionEpochRef = React.useRef(0);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const projectAttemptRef = React.useRef(0), [projectAttempt, setProjectAttempt] = useState(0);
  const projectIssuance = React.useRef(0);
  const projectDenial = React.useRef<{ session: number; selection: number; id: string } | null>(null);
  const [, refreshProjectDenial] = React.useReducer((value: number) => value + 1, 0);
  const changeSelected = (value: string | null) => {
    if (selectedRef.current !== value) {
      selectedRef.current = value; advanceQueueView(); selectionEpochRef.current++; setSelectionEpoch(selectionEpochRef.current); healthFence.switchScope(healthVisible());
    } else healthTransition();
    invalidateReassessment(); setSelected(value);
  };
  const changeView = (value: "projects" | "platform" | "ingestion") => {
    if (viewRef.current !== value) { viewRef.current = value; advanceQueueView(); }
    healthTransition(); invalidateReassessment(); setView(value);
  };
  const [creating, setCreatingState] = useState(false);
  const creatingRef = React.useRef(false), creationEpoch = React.useRef(0);
  const renderedCreationEpoch = creationEpoch.current;
  const setCreating = (value: boolean) => {
    if (creatingRef.current !== value) { creatingRef.current = value; creationEpoch.current++; advanceQueueView(); }
    setCreatingState(value);
  };
  const [updateLocator, setUpdateLocatorState] = useState<string | null>(updateRequestLocation);
  const updateLocatorRef = React.useRef(updateLocator);
  const setUpdateLocator = (value: string | null) => {
    if (updateLocatorRef.current !== value) { updateLocatorRef.current = value; advanceQueueView(); }
    setUpdateLocatorState(value);
  };
  const [linkedAssessment, setLinkedAssessment] = useState<string | null>(null);
  const [linkedRequest, setLinkedRequest] = useState<string | null>(null);
  const [linkedScalarRequest, setLinkedScalarRequest] = useState<string | null>(
    null,
  );
  React.useEffect(() => {
    expireSession = (reason) => {
      accessToken = undefined;
      advanceSession();
      idToken = undefined;
      setSignedIn(false);
      changeSelected(null);
      setCreating(false);
      setLinkedAssessment(null);
      setLinkedRequest(null);
      setLinkedScalarRequest(null);
      changeView("projects");
      setError(reason === "identity-unavailable" ? "Your access could not be established. Please sign in again." : "Your session has ended. Please sign in again.");
      clearProtectedData();
    };
    return () => {
      expireSession = undefined;
    };
  }, []);
  const auth = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => rawRequest<AuthConfig>("/auth/config"),
  });
  const identityKey = ["me", renderedSessionGeneration] as const;
  const identityIssuance = React.useRef(0);
  const verifiedIdentityOwner = React.useRef<string | null>(null);
  const currentSelection = () => isCurrentPreviewSession() && selected !== null &&
    selectedRef.current === selected && selectionEpochRef.current === selectionEpoch;
  const selectionDenied = () => Boolean(projectDenial.current && projectDenial.current.session === renderedSessionGeneration &&
    projectDenial.current.selection === selectionEpoch && projectDenial.current.id === selected);
  const me = useProtectedQuery({
    queryKey: identityKey,
    queryFn: async () => {
      if (!isCurrentPreviewSession()) throw new Error("The session changed before this request started.");
      const issuance = ++identityIssuance.current;
      const current = () => isCurrentPreviewSession() && identityIssuance.current === issuance;
      healthTransition();
      const value = await request<unknown>("/me", {}, 65_536,
        (denied) => { if (denied && current()) expireSession?.("identity-unavailable"); }, undefined, current, 200);
      let actor: Actor | undefined;
      try { actor = decodeWireIdentity(value); } catch { /* Invalid identity is unavailable. */ }
      if (!current() || !actor) throw new Error("Your access could not be established. Please try again.");
      const owner = JSON.stringify([renderedSessionGeneration, actor.customerId, actor.subject, [...actor.roles].sort()]);
      if (verifiedIdentityOwner.current !== owner) {
        verifiedIdentityOwner.current = owner;
        projectDenial.current = null;
      }
      return actor;
    },
    enabled: signedIn,
  });
  const renderedActor = me.data, renderedIdentityIssuance = identityIssuance.current;
  // A selected-project check belongs to the exact completed identity check,
  // even when the same bearer is subsequently associated with another actor.
  const identityCurrent = React.useCallback(() => {
    const state = client.getQueryState<Actor>(["me", renderedSessionGeneration]);
    return Boolean(isCurrentPreviewSession() && renderedActor && identityIssuance.current === renderedIdentityIssuance &&
      state?.status === "success" && state.fetchStatus === "idle" && state.data === renderedActor);
  }, [isCurrentPreviewSession, renderedActor, renderedIdentityIssuance, renderedSessionGeneration]);
  const isCurrentQueueView = React.useCallback(() => Boolean(identityCurrent() && renderedActor?.roles.includes("project_manager") &&
    queueViewRevisionRef.current === queueViewRevision && viewRef.current === "projects" && selectedRef.current === null &&
    !creatingRef.current && updateLocatorRef.current === null), [identityCurrent, renderedActor, queueViewRevision]);
  const identityRequest = React.useMemo(() => bindSessionRequest(request, identityCurrent),
    [request, renderedActor, renderedIdentityIssuance]);
  const projectsKey = ["projects", renderedSessionGeneration, renderedIdentityIssuance] as const;
  const setupKey = ["project-setup", renderedSessionGeneration, renderedIdentityIssuance] as const;
  const projectsIssuance = React.useRef(0), setupIssuance = React.useRef(0);
  const identityReady = signedIn && !!me.data && !me.isFetching && !me.isError;
  const selectedProjectKey = ["project", selected, renderedSessionGeneration, selectionEpoch, projectAttempt, renderedIdentityIssuance] as const;
  const projects = useProtectedQuery({
    queryKey: projectsKey,
    queryFn: async () => {
      if (!identityCurrent()) throw new Error("Project access is unavailable.");
      const issuance = ++projectsIssuance.current;
      const current = () => identityCurrent() && projectsIssuance.current === issuance;
      const raw = await identityRequest<unknown>("/projects", {}, 16 * 1024 * 1024, undefined, undefined, current, 200);
      let value: ReturnType<typeof decodeProjectList> = null;
      try { value = decodeProjectList(raw); } catch { /* Treat malformed content as unavailable. */ }
      if (!current() || !value) throw new Error("Project access is unavailable.");
      return { issuance, value };
    },
    enabled: identityReady,
  });
  const renderedProjects = projects.data;
  const isCurrentProjectList = () => {
    const state = client.getQueryState<{ issuance: number; value: Project[] }>(projectsKey);
    return Boolean(identityCurrent() && renderedProjects && projectsIssuance.current === renderedProjects.issuance &&
      state?.status === "success" && state.fetchStatus === "idle" && state.data === renderedProjects);
  };
  const project = useProtectedQuery({
    queryKey: selectedProjectKey,
    queryFn: async () => {
      if (!identityCurrent() || !currentSelection() || selectionDenied()) throw new Error("The project selection is unavailable.");
      const issuance = ++projectIssuance.current;
      const current = () => identityCurrent() && currentSelection() && !selectionDenied() && projectAttemptRef.current === projectAttempt && projectIssuance.current === issuance;
      healthTransition();
      const result = await request<Project>("/projects/" + selected, {}, 1_048_576, (denied) => {
        if (!denied || !current() || !selected) return;
        projectDenial.current = { session: renderedSessionGeneration, selection: selectionEpoch, id: selected };
        healthTransition(); invalidateReassessment(); pmPreviewInvalidate.current?.(); refreshProjectDenial();
      }, undefined, current, 200);
      if (!current() || result?.id !== selected) throw new Error("This project is unavailable for your account.");
      return result;
    },
    enabled: signedIn && !!selected && !!me.data && !me.isFetching && !me.isError && !selectionDenied(),
  });
  const renderedProject = selected, renderedProjectIssuance = projectIssuance.current;
  const isCurrentProjectAdmission = () => {
    const state = client.getQueryState<Project>(selectedProjectKey), identity = client.getQueryState<Actor>(identityKey);
    return Boolean(renderedActor && identity?.status === "success" && identity.fetchStatus === "idle" &&
      identityIssuance.current === renderedIdentityIssuance && identity.data?.customerId === renderedActor.customerId &&
      identity.data.subject === renderedActor.subject && [...identity.data.roles].sort().join("\0") === [...renderedActor.roles].sort().join("\0") &&
      currentSelection() && !selectionDenied() && projectAttemptRef.current === projectAttempt &&
      projectIssuance.current === renderedProjectIssuance && state?.status === "success" &&
      state.fetchStatus === "idle" && state.data?.id === selected);
  };
  const projectRequest = React.useMemo(() => bindSessionRequest(request, isCurrentProjectAdmission),
  [request, selected, selectionEpoch, projectAttempt, renderedIdentityIssuance, renderedProjectIssuance, renderedActor]);
  const projectPreviewRequest = React.useMemo(() =>
    (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void): Promise<unknown> =>
      projectRequest(path, init, 65536, onUnavailable), [projectRequest]);
  const retrySelectedProject = () => {
    if (!identityCurrent() || !currentSelection() || !selectionDenied()) return;
    projectAttemptRef.current++; projectDenial.current = null; setProjectAttempt(projectAttemptRef.current);
    refreshProjectDenial();
  };
  const retryProjectChecks = () => {
    if (!currentSelection() || selectionDenied()) return;
    void client.invalidateQueries({ queryKey: identityKey, exact: true });
  };
  const renderedHealthToken = accessToken, renderedHealthSession = sessionGeneration;
  const isCurrentHealthScope = () => {
    const identity = client.getQueryState<Actor>(identityKey), currentProject = client.getQueryState<Project>(selectedProjectKey);
    return Boolean(renderedHealthToken && accessToken === renderedHealthToken && sessionGeneration === renderedHealthSession &&
      !healthPageHidden && document.visibilityState === "visible" && renderedActor && renderedProject && currentSelection() && !selectionDenied() &&
      projectAttemptRef.current === projectAttempt && identityIssuance.current === renderedIdentityIssuance &&
      projectIssuance.current === renderedProjectIssuance &&
      identity?.status === "success" && identity.fetchStatus === "idle" &&
      identity.data?.customerId === renderedActor.customerId && identity.data.subject === renderedActor.subject &&
      [...identity.data.roles].sort().join("\0") === [...renderedActor.roles].sort().join("\0") &&
      currentProject?.status === "success" && currentProject.fetchStatus === "idle" && currentProject.data?.id === renderedProject);
  };
  React.useEffect(() => {
    const revalidate = () => {
      healthTransition();
      if (accessToken && !healthPageHidden && document.visibilityState === "visible") {
        void client.invalidateQueries({ queryKey: ["me", sessionGeneration], exact: true });
      }
    };
    const hide = () => { healthPageHidden = true; healthFence.transition(false); };
    const show = () => { healthPageHidden = false; revalidate(); };
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("pagehide", hide);
    return () => { window.removeEventListener("focus", revalidate); window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", revalidate); window.removeEventListener("pagehide", hide); };
  }, []);
  const renderedActorUpdatedAt = client.getQueryState(identityKey)?.dataUpdatedAt;
  const renderedProjectUpdatedAt = client.getQueryState(selectedProjectKey)?.dataUpdatedAt;
  const isCurrentReassessmentScope = () => {
    const identity = client.getQueryState<Actor>(identityKey), projectState = client.getQueryState<Project>(selectedProjectKey);
    return currentSelection() && !selectionDenied() && projectAttemptRef.current === projectAttempt &&
      identityIssuance.current === renderedIdentityIssuance && projectIssuance.current === renderedProjectIssuance &&
      renderedReassessmentScope === reassessmentScope.current && !!renderedActor &&
      !!renderedProject && identity?.fetchStatus === "idle" && identity.status === "success" &&
      identity.dataUpdatedAt === renderedActorUpdatedAt && projectState?.dataUpdatedAt === renderedProjectUpdatedAt &&
      identity.data?.customerId === renderedActor.customerId && identity.data.subject === renderedActor.subject &&
      identity.data.roles.join(",") === renderedActor.roles.join(",") && identity.data.roles.includes("pmo_admin") &&
      projectState?.fetchStatus === "idle" && projectState.status === "success" && projectState.data?.id === renderedProject;
  };
  const admin = me.data?.roles.some((r) =>
    ["system_admin", "pmo_admin"].includes(r),
  );
  const pmoAdmin = me.data?.roles.includes("pmo_admin");
  // Retained data only keeps an existing draft owner mounted through a
  // transient error. Current query state still gates all display and actions.
  const retainedActor = me.data ?? (!denied(me.error) ? me.lastData : undefined);
  const retainedProjectOwner = React.useRef<{ key: string; value: Project } | null>(null);
  const retentionKey = retainedActor && selected ? JSON.stringify([renderedSessionGeneration, selectionEpoch, projectAttempt, selected,
    retainedActor.customerId, retainedActor.subject, [...retainedActor.roles].sort()]) : null;
  if (!retentionKey || selectionDenied() || retainedProjectOwner.current?.key !== retentionKey) retainedProjectOwner.current = null;
  if (retentionKey && project.data && isCurrentProjectAdmission()) retainedProjectOwner.current = { key: retentionKey, value: project.data };
  const retainedProject = retainedProjectOwner.current?.key === retentionKey ? retainedProjectOwner.current.value : undefined;
  const projectVisible = Boolean(me.data && project.data && !me.isFetching && !me.isError && !project.isFetching && !project.isError && isCurrentProjectAdmission());
  const evidenceAdmission = React.useMemo(() => projectVisible ? Object.freeze({}) : null,
    [projectVisible, renderedSessionGeneration, selectionEpoch, projectAttempt, renderedIdentityIssuance, renderedProjectIssuance]);
  const setup = useProtectedQuery({
    queryKey: setupKey,
    queryFn: async () => {
      if (!identityCurrent()) throw new Error("Project setup access is unavailable.");
      const issuance = ++setupIssuance.current;
      const current = () => identityCurrent() && setupIssuance.current === issuance;
      const raw = await identityRequest<unknown>("/project-setup", {}, 8 * 1024 * 1024, undefined, undefined, current, 200);
      let value: ReturnType<typeof decodeProjectSetup> = null;
      try { value = decodeProjectSetup(raw); } catch { /* Treat malformed content as unavailable. */ }
      if (!current() || !value) throw new Error("Project setup access is unavailable.");
      return { issuance, value };
    },
    enabled: identityReady,
  });
  const renderedSetup = setup.data;
  const isCurrentSetup = () => {
    const state = client.getQueryState<{ issuance: number; value: ProjectSetup }>(setupKey);
    return Boolean(identityCurrent() && renderedSetup && setupIssuance.current === renderedSetup.issuance &&
      state?.status === "success" && state.fetchStatus === "idle" && state.data === renderedSetup);
  };
  const setupRequest = React.useMemo(() => bindSessionRequest(identityRequest, isCurrentSetup),
    [identityRequest, renderedSetup]);
  const isCurrentCreationIdentity = () => identityCurrent() && creatingRef.current && creationEpoch.current === renderedCreationEpoch;
  const isCurrentCreationScope = () => isCurrentCreationIdentity() && isCurrentSetup();
  const creationRequest = React.useMemo(() => bindSessionRequest(setupRequest, isCurrentCreationIdentity),
    [setupRequest, renderedCreationEpoch]);
  const retainedSetupOwner = React.useRef<{ key: string; value: ProjectSetup } | null>(null);
  const setupOwnerKey = retainedActor ? JSON.stringify([renderedSessionGeneration, retainedActor.customerId,
    retainedActor.subject, [...retainedActor.roles].sort()]) : null;
  if (!setupOwnerKey || retainedSetupOwner.current?.key !== setupOwnerKey) retainedSetupOwner.current = null;
  if (setupOwnerKey && renderedSetup && isCurrentSetup()) retainedSetupOwner.current = { key: setupOwnerKey, value: renderedSetup.value };
  const retainedSetup = retainedSetupOwner.current?.key === setupOwnerKey ? retainedSetupOwner.current.value : undefined;
  const visibleProjects = isCurrentProjectList() ? renderedProjects?.value : undefined;
  const visibleSetup = isCurrentSetup() ? renderedSetup?.value : undefined;
  const invitationViewCurrent = React.useCallback(() => Boolean(identityCurrent() && updateLocator &&
    updateLocatorRef.current === updateLocator && queueViewRevisionRef.current === queueViewRevision),
  [identityCurrent, updateLocator, queueViewRevision]);
  const invitationRequest = React.useMemo(() => bindSessionRequest(identityRequest, invitationViewCurrent),
    [identityRequest, invitationViewCurrent]);
  const platformViewCurrent = React.useCallback(() => Boolean(identityCurrent() && renderedActor?.roles.some((role) =>
    role === "system_admin" || role === "pmo_admin") && viewRef.current === "platform" &&
    queueViewRevisionRef.current === queueViewRevision && updateLocatorRef.current === null),
  [identityCurrent, renderedActor, queueViewRevision]);
  const platformRequest = React.useMemo(() => bindSessionRequest(identityRequest, platformViewCurrent),
    [identityRequest, platformViewCurrent]);
  const csvViewCurrent = () => Boolean(identityCurrent() && isCurrentProjectList() && renderedActor?.roles.includes("pmo_admin") &&
    viewRef.current === "ingestion" && queueViewRevisionRef.current === queueViewRevision && updateLocatorRef.current === null);
  const csvRequest = React.useMemo(() => bindSessionRequest(identityRequest, csvViewCurrent),
    [identityRequest, renderedProjects, queueViewRevision]);
  const retrySetup = () => {
    if (identityCurrent()) void client.invalidateQueries({ queryKey: setupKey, exact: true });
  };
  async function login(persona?: string) {
    setBusy(true);
    setError("");
    try {
      if (auth.data?.mode === "development") {
        const result = await rawRequest<{ token: string }>("/auth/development", {
          method: "POST",
          body: JSON.stringify({ persona }),
        });
        accessToken = result.token;
        advanceSession();
        setSignedIn(true);
        setUpdateLocator(updateRequestLocation());
        const link = evidenceLocation();
        if (link) {
          changeSelected(link.projectId);
          setLinkedAssessment(link.assessmentId);
          setLinkedRequest(link.requestId);
          setLinkedScalarRequest(link.scalarRequestId);
        }
      } else if (auth.data)
        await manager(auth.data).signinRedirect({ state: { ...evidenceLocation(), updateLocator: updateRequestLocation() } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  React.useEffect(() => {
    if (
      window.location.pathname !== "/auth/callback" ||
      !auth.data ||
      auth.data.mode !== "oidc"
    )
      return;
    let active = true;
    manager(auth.data)
      .signinRedirectCallback()
      .then((user) => {
        if (user.expired) throw new Error("Expired sign-in");
        if (active) {
          accessToken = user.access_token;
          advanceSession();
          idToken = user.id_token;
          const state = user.state as {
            projectId?: unknown;
            assessmentId?: unknown;
            requestId?: unknown;
            scalarRequestId?: unknown;
            updateLocator?: unknown;
          } | null;
          const linked =
            typeof state?.projectId === "string" &&
            uuid.test(state.projectId) &&
            ((typeof state?.scalarRequestId === "string" &&
              !state.assessmentId &&
              !state.requestId &&
              uuid.test(state.scalarRequestId)) ||
              (typeof state?.assessmentId === "string" &&
                !state.scalarRequestId &&
                !state.requestId &&
                uuid.test(state.assessmentId)) ||
              (typeof state?.requestId === "string" &&
                !state.scalarRequestId &&
                !state.assessmentId &&
                uuid.test(state.requestId)));
          const recipientLocator = typeof state?.updateLocator === "string" && uuid.test(state.updateLocator)
            ? state.updateLocator : null;
          setUpdateLocator(recipientLocator);
          window.history.replaceState(
            {},
            "",
            recipientLocator ? "/update-requests/" + recipientLocator : linked
              ? typeof state?.scalarRequestId === "string"
                ? savedScalarReconciliationLink(
                    state.projectId as string,
                    state.scalarRequestId,
                  )
                : typeof state?.requestId === "string"
                  ? savedReconciliationLink(
                      state.projectId as string,
                      state.requestId,
                    )
                  : savedEvidenceLink(
                      state.projectId as string,
                      state.assessmentId as string,
                    )
              : "/",
          );
          if (linked) {
            changeSelected(state.projectId as string);
            setLinkedAssessment(
              typeof state.assessmentId === "string"
                ? state.assessmentId
                : null,
            );
            setLinkedRequest(
              typeof state.requestId === "string" ? state.requestId : null,
            );
            setLinkedScalarRequest(
              typeof state.scalarRequestId === "string"
                ? state.scalarRequestId
                : null,
            );
          }
          setSignedIn(true);
        }
      })
      .catch(() => {
        if (active)
          setError("Sign-in could not be verified. Please try again.");
      });
    return () => {
      active = false;
    };
  }, [auth.data]);
  async function logout() {
    const logoutHint = idToken;
    idToken = undefined;
    accessToken = undefined;
    advanceSession();
    setSignedIn(false);
    changeSelected(null);
    setCreating(false);
    setLinkedAssessment(null);
    setLinkedRequest(null);
    setLinkedScalarRequest(null);
    changeView("projects");
    clearProtectedData();
    if (auth.data?.mode === "oidc" && oidc) {
      try {
        await oidc.removeUser();
        await oidc.signoutRedirect({ id_token_hint: logoutHint });
      } catch {
        setError(
          "You are signed out of this application. Identity-provider sign-out could not be completed.",
        );
      }
    }
  }
  function navigateProject(id: string | null = null) {
    if (!identityCurrent()) return;
    setUpdateLocator(null);
    changeView("projects");
    setCreating(false);
    changeSelected(id);
    setLinkedAssessment(null);
    setLinkedRequest(null);
    setLinkedScalarRequest(null);
    window.history.replaceState({}, "", "/");
  }
  function navigateReconciliation(projectId: string, kind: "milestone" | "scalar", requestId: string) {
    if (!identityCurrent()) return;
    navigateProject(projectId);
    if (kind === "scalar") setLinkedScalarRequest(requestId);
    else setLinkedRequest(requestId);
    window.history.replaceState({}, "", kind === "scalar"
      ? savedScalarReconciliationLink(projectId, requestId) : savedReconciliationLink(projectId, requestId));
  }
  const displayName =
    me.data?.subject === "pm-atlas"
      ? "Atlas project manager"
      : me.data?.subject === "operator"
        ? "Platform operator"
        : me.data?.subject === "leader-atlas"
          ? "Atlas leadership"
          : me.data?.subject;
  if (!signedIn)
    return (
      <div className="login">
        <section className="login-story">
          <div className="brand">
            <span className="brand-mark">da</span> Delivery Assurance
          </div>
          <div className="story-copy">
            <span className="eyebrow">A CLEARER VIEW OF DELIVERY</span>
            <h1>
              Confidence starts
              <br />
              with evidence.
            </h1>
            <p>
              One place to understand project commitments, follow up on missing
              information, and keep decisions traceable.
            </p>
            <div className="story-line" />
            <small>Customer-hosted · Permission-aware · Human-approved</small>
          </div>
          <span className="login-footer">
            PROJECT DELIVERY ASSURANCE AGENT / FOUNDATION
          </span>
        </section>
        <main className="login-form">
          <span className="pill">
            {auth.data?.dataMode === "synthetic"
              ? "Synthetic workspace"
              : "Customer workspace"}
          </span>
          <h2>Welcome to your workspace</h2>
          <p className="muted">
            {auth.data?.mode === "development"
              ? "Explore the foundation with a sample account. All project information here is synthetic."
              : "Sign in with your organization to see projects shared with you."}
          </p>
          {(error || auth.error) && (
            <p role="alert" className="error">
              {error || "Unable to connect to the service."}
            </p>
          )}
          {auth.isPending ? (
            <p role="status">Connecting to your workspace…</p>
          ) : auth.data?.mode === "development" ? (
            <div className="personas">
              <Button disabled={busy} onClick={() => login("pm-atlas")}>
                <span>
                  <strong>Project manager</strong>
                  <small>View the Atlas project workspace</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
              <Button disabled={busy} onClick={() => login("leader-atlas")}>
                <span>
                  <strong>Leadership</strong>
                  <small>Review projects shared with you</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
              <Button disabled={busy} onClick={() => login("operator")}>
                <span>
                  <strong>Platform operator</strong>
                  <small>Manage access and check service health</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
              <Button disabled={busy} onClick={() => login("pmo-portfolio")}>
                <span>
                  <strong>PMO administrator</strong>
                  <small>Create projects in the synthetic portfolio</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
            </div>
          ) : (
            <Button
              className="primary"
              disabled={!auth.data || busy}
              onClick={() => login()}
            >
              Sign in with your organization
            </Button>
          )}
          <p className="login-note">
            {auth.data?.mode === "development"
              ? "Preview access is limited to this local development environment."
              : "Access follows your organization’s project and portfolio permissions."}
          </p>
        </main>
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">da</span>
          <span>
            Delivery
            <br />
            Assurance
          </span>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          <Button
            className={view === "projects" ? "active" : ""}
            onClick={() => navigateProject()}
          >
            <span aria-hidden="true">▦</span> Projects
          </Button>
          {admin && (
            <Button
              className={view === "platform" ? "active" : ""}
              onClick={() => {
                if (!identityCurrent()) return;
                navigateProject();
                changeView("platform");
              }}
            >
              <span aria-hidden="true">⚙</span> Platform & access
            </Button>
          )}
          {pmoAdmin && (
            <Button
              className={view === "ingestion" ? "active" : ""}
              onClick={() => {
                if (!identityCurrent()) return;
                navigateProject();
                changeView("ingestion");
              }}
            >
              <span aria-hidden="true">⇧</span> Data imports
            </Button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="scope-dot" /> Customer-hosted workspace
          <small>Foundation preview · v0.1</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span>{" "}
            {view === "projects" ? "Projects" : view === "platform" ? "Platform" : "Data imports"}
          </span>
          <div>
            <span className="pill">
              {auth.data?.dataMode === "synthetic"
                ? "Synthetic data"
                : "Customer data"}
            </span>
            <Button className="text-button" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">DELIVERY ASSURANCE</span>
              <h1>
                {view === "platform"
                  ? "Platform & access"
                  : view === "ingestion"
                    ? "Data imports"
                  : selected
                    ? (projectVisible ? project.data?.name ?? "Project workspace" : "Project workspace")
                    : "Your projects"}
              </h1>
              <p className="muted">
                {view === "platform"
                  ? "Service health, scoped access, and a record of administrative changes."
                  : view === "ingestion"
                    ? "Configure a CSV source, review its preview, and save selected proposals."
                  : selected
                    ? "A shared starting point for project evidence and decisions."
                    : "A focused view of the projects you have permission to access."}
              </p>
            </div>
            <div className="account">
              <span className="avatar">{admin ? "OP" : "AT"}</span>
              <span>
                <strong>{displayName ?? "Loading account…"}</strong>
                <small>{me.data?.roles.join(", ").replaceAll("_", " ")}</small>
              </span>
            </div>
          </div>
          {me.error && (
            <div role="alert" className="error">
              <p>{me.error.message}</p>
              <Button className="secondary" disabled={me.isFetching} onClick={() => {
                if (isCurrentPreviewSession()) void client.invalidateQueries({ queryKey: identityKey, exact: true });
              }}>Retry account access</Button>
            </div>
          )}
          {updateLocator ? (
            retainedActor && setupOwnerKey ? <>
              {!invitationViewCurrent() && <p role="status">Checking account access…</p>}
              <div hidden={!invitationViewCurrent()}>
                <ProjectUpdateResponse key={JSON.stringify([setupOwnerKey, updateLocator, queueViewRevision])}
                  locator={updateLocator} customerId={retainedActor.customerId} subject={retainedActor.subject}
                  ownerScope={JSON.stringify([setupOwnerKey, queueViewRevision])}
                  admissionScope={JSON.stringify([renderedSessionGeneration, queueViewRevision, renderedIdentityIssuance])}
                  request={invitationRequest} isCurrentScope={invitationViewCurrent} />
              </div>
            </> : <p role="status">Checking account access…</p>
          ) : view === "platform" && retainedActor && setupOwnerKey && retainedActor.roles.some((role) => role === "system_admin" || role === "pmo_admin") ? (
            <>
              {!platformViewCurrent() && <p role="status">Checking account access…</p>}
              <div hidden={!platformViewCurrent()}>
                <PlatformView key={JSON.stringify([setupOwnerKey, queueViewRevision])} actor={retainedActor}
                  ownerScope={JSON.stringify([setupOwnerKey, queueViewRevision])}
                  admissionScope={JSON.stringify([renderedIdentityIssuance, queueViewRevision])}
                  request={platformRequest} isCurrentScope={platformViewCurrent} />
              </div>
            </>
          ) : view === "ingestion" && retainedActor && setupOwnerKey && retainedActor.roles.includes("pmo_admin") ? (
            <>
              {!csvViewCurrent() && <p role="status">Checking account and project access…</p>}
              <div hidden={!csvViewCurrent()}>
                <CsvIngestion key={JSON.stringify([setupOwnerKey, queueViewRevision])} request={csvRequest}
                  projects={visibleProjects ?? []} actor={retainedActor} isCurrentScope={csvViewCurrent} />
              </div>
            </>
          ) : creating && retainedSetup ? (
            <>
              {!isCurrentSetup() && (setup.isError && identityCurrent()
                ? <div role="alert"><p>Project setup is unavailable.</p><Button className="secondary" onClick={retrySetup}>Retry project setup</Button></div>
                : <p role="status">Checking project setup access…</p>)}
              <div hidden={!isCurrentSetup()}>
                <CreateProject
                  key={setupOwnerKey}
                  setup={visibleSetup ?? retainedSetup}
                  customerId={retainedActor!.customerId}
                  subject={retainedActor!.subject}
                  request={creationRequest}
                  isCurrentScope={isCurrentCreationScope}
                  isCurrentIdentity={isCurrentCreationIdentity}
                  onCancel={() => { if (isCurrentCreationScope()) setCreating(false); }}
                  onSetupChanged={async () => {
                    if (!isCurrentCreationIdentity()) throw new Error("Project setup access changed.");
                    await client.invalidateQueries({ queryKey: setupKey, exact: true });
                    if (!isCurrentCreationIdentity()) throw new Error("Project setup access changed.");
                    const refreshed = client.getQueryState<{ issuance: number; value: ProjectSetup }>(setupKey);
                    if (refreshed?.status !== "success" || refreshed.fetchStatus !== "idle" || !refreshed.data)
                      throw new Error("Project setup could not be refreshed.");
                    if (refreshed.data.issuance !== setupIssuance.current) throw new Error("Project setup access changed.");
                    return refreshed.data.value;
                  }}
                  onCreated={(id) => {
                    if (!isCurrentCreationScope()) return;
                    navigateProject(id);
                    void client.invalidateQueries({ queryKey: projectsKey, exact: true });
                  }}
                />
              </div>
            </>
          ) : selected ? (
            <>
              <Button
                className="back text-button"
                onClick={() => navigateProject()}
              >
                ← All projects
              </Button>
              {selectionDenied() && <div role="alert" className="error">
                <p>Project access could not be established.</p>
                <Button className="secondary" disabled={!identityCurrent()} onClick={retrySelectedProject}>Check project access</Button>
              </div>}
              {project.error && !selectionDenied() && (
                <div role="alert" className="error">
                  <p>{project.error.message}</p>
                  {!retainedProject && <Button className="secondary" onClick={retryProjectChecks}>Retry access checks</Button>}
                </div>
              )}
              {retainedProject ? (
                <HealthScopeProvider key={JSON.stringify([renderedSessionGeneration, selectionEpoch, projectAttempt,
                  retainedActor?.customerId, retainedActor?.subject, [...(retainedActor?.roles ?? [])].sort()])}
                  fence={healthFence} actor={retainedActor ?? emptyHealthActor} projectId={retainedProject.id}
                  session={renderedHealthSession} request={projectRequest} isCurrent={isCurrentHealthScope}
                  visible={projectVisible}>
                  {!projectVisible && (me.isFetching || project.isFetching
                    ? <p role="status">Checking project access…</p>
                    : <div role="alert"><p>Project access could not be established.</p>
                      <Button className="secondary" onClick={retryProjectChecks}>Retry access checks</Button></div>)}
                  <EvidenceAdmissionContext.Provider value={evidenceAdmission}>
                  <div hidden={!projectVisible}>
                  {project.data && <ProjectDetail project={project.data} />}
                  {retainedProject && (
                    <ProjectUpdates
                      key={`project-updates:${retainedProject.id}`}
                      projectId={retainedProject.id}
                      reportedStatus={retainedProject.reportedStatus}
                      request={projectRequest}
                      pmoAdmin={Boolean(retainedActor?.roles.includes("pmo_admin"))}
                      visible={projectVisible}
                      isCurrentScope={isCurrentProjectAdmission}
                      writeOwner={projectPolicyOwner(retainedActor?.customerId, retainedProject.id)}
                      admissionScope={JSON.stringify([renderedSessionGeneration, selectionEpoch, projectAttempt,
                        renderedIdentityIssuance, renderedProjectIssuance, renderedActor?.customerId, renderedActor?.subject,
                        [...(renderedActor?.roles ?? [])].sort()])}
                    />
                  )}
                  {retainedProject && (
                    <HealthAssessmentPanel
                      key={JSON.stringify([sessionGeneration, retainedActor?.customerId, retainedActor?.subject, [...(retainedActor?.roles ?? [])].sort(), retainedProject.id, selectionEpoch])}
                      projectId={retainedProject.id}
                      reportedStatus={retainedProject.reportedStatus}
                      pmoAdmin={pmoAdmin ?? false}
                      canInspectMilestone={Boolean(me.data?.roles.includes("leadership"))}
                      visible={Boolean(me.data && project.data && !me.isFetching && !me.isError && !project.isFetching && !project.isError)}
                    />
                  )}
                  {project.data && me.data && !project.isFetching && !project.isError && (
                    <DeliverySuggestions
                      key={`suggestions:${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      projectId={project.data.id}
                      scope={`${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      request={projectRequest}
                    />
                  )}
                  {project.data && me.data && !project.isFetching && !project.isError && (
                    <UpdateSuggestions
                      key={`update-suggestions:${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      projectId={project.data.id}
                      scope={`${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      request={projectRequest}
                    />
                  )}
                  {project.data && me.data?.roles.includes("leadership") && !project.isFetching && !project.isError && (
                    <LeadershipBlockerAge
                      key={`leadership-blocker:${sessionGeneration}:${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      projectId={project.data.id}
                      scope={`${sessionGeneration}:${me.data.customerId}:${me.data.subject}:${project.data.id}`}
                      request={projectRequest}
                    />
                  )}
                  {project.data && me.data?.roles.includes("pmo_admin") && !me.isFetching && !me.isError && !project.isFetching && !project.isError && (
                    <IngestionReassessmentPreview
                      key={`ingestion-reassessment:${sessionGeneration}:${me.data.customerId}:${me.data.subject}:${me.data.roles.join(",")}:${project.data.id}`}
                      projectId={project.data.id}
                      request={projectPreviewRequest}
                      invalidateRef={reassessmentInvalidate}
                      isCurrentScope={isCurrentReassessmentScope}
                    />
                  )}
                  <MilestoneReconciliation
                    key={`reconciliation:${retainedProject.id}`}
                    projectId={retainedProject.id}
                    request={projectRequest}
                    initialRequestId={linkedRequest}
                    visible={!project.isFetching && !project.isError}
                  />
                  <ProjectEvidence
                    key={retainedProject.id}
                    projectId={retainedProject.id}
                    request={projectRequest}
                    initialAssessmentId={linkedAssessment}
                    initialScalarRequestId={linkedScalarRequest}
                    visible={!project.isFetching && !project.isError}
                  />
                  <div id="delivery-structure" tabIndex={-1}>
                  {project.data && (
                    <CanonicalProjectDetails
                      key={JSON.stringify([sessionGeneration, me.data?.customerId, me.data?.subject, [...(me.data?.roles ?? [])].sort(), project.data.id])}
                      id={project.data.id}
                      leadershipScope={me.data?.roles.includes("leadership") && !me.isFetching && !me.isError && !project.isFetching && !project.isError
                        ? JSON.stringify([sessionGeneration, me.data.customerId, me.data.subject, [...me.data.roles].sort(), project.data.id]) : undefined}
                      canInspectMilestoneRequest={Boolean(me.data?.roles.some((role) => ["project_manager", "portfolio_manager", "pmo_admin"].includes(role)))}
                    />
                  )}
                  </div>
                  </div>
                  </EvidenceAdmissionContext.Provider>
                </HealthScopeProvider>
              ) : (
                !project.error && !selectionDenied() && <p role="status">Loading project…</p>
              )}
            </>
          ) : (
            <>
              {me.data?.roles.includes("project_manager") && identityCurrent() && <PmActionQueuePanel
                key={`pm-queue:${sessionGeneration}:${renderedIdentityIssuance}:${queueViewRevision}:${me.data.customerId}:${me.data.subject}:${me.data.roles.join(",")}`}
                scope={`${sessionGeneration}:${renderedIdentityIssuance}:${queueViewRevision}:${me.data.customerId}:${me.data.subject}:${me.data.roles.join(",")}`}
                subject={me.data.subject}
                request={identityRequest}
                previewInvalidate={pmPreviewInvalidate}
                isCurrentPreviewSession={isCurrentQueueView}
                openProject={navigateProject}
                openRequest={navigateReconciliation}
              />}
              <div className="summary-strip">
                <div>
                  <span>Accessible projects</span>
                  <strong>{visibleProjects?.length ?? "—"}</strong>
                </div>
                <div>
                  <span>Evidence connections</span>
                  <strong>
                    0 <small>Awaiting setup</small>
                  </strong>
                </div>
                <div>
                  <span>Delivery assessment</span>
                  <strong className="quiet-value">Available on project detail</strong>
                </div>
              </div>
              <div className="section-title">
                <h2>Project workspace</h2>
                {visibleSetup?.portfolios.length ? (
                  <Button
                    className="primary"
                    onClick={() => {
                      if (!isCurrentSetup()) return;
                      navigateProject();
                      setCreating(true);
                    }}
                  >
                    Create project
                  </Button>
                ) : null}
                <span>{visibleProjects ? `${visibleProjects.length} visible` : "Project count unavailable"}</span>
              </div>
              {setup.isError && identityCurrent() && <div role="alert"><p>Project setup is unavailable.</p>
                <Button className="secondary" onClick={retrySetup}>Retry project setup</Button></div>}
              {projects.error && identityCurrent() && (
                <div role="alert" className="error">
                  <p>{projects.error.message}</p>
                  <Button className="secondary" onClick={() => {
                    if (identityCurrent()) void client.invalidateQueries({ queryKey: projectsKey, exact: true });
                  }}>Retry project access</Button>
                </div>
              )}
              {!identityCurrent() || projects.isPending || projects.isFetching ? (
                <p role="status">Checking project access…</p>
              ) : visibleProjects?.length ? (
                <div className="project-grid">
                  {visibleProjects.map((p) => (
                    <Button
                      key={p.id}
                      className="project-card"
                      onClick={() => { if (isCurrentProjectList()) navigateProject(p.id); }}
                    >
                      <div className="card-top">
                        <span className="project-code">{p.code}</span>
                        <span className="pill neutral">Awaiting evidence</span>
                      </div>
                      <h3>{p.name}</h3>
                      <p>{p.description}</p>
                      <div className="card-bottom">
                        <span>Open project workspace</span>
                        <span aria-hidden="true">↗</span>
                      </div>
                    </Button>
                  ))}
                </div>
              ) : (
                !projects.error && (
                  <div className="empty">
                    <h3>No projects are shared with this account</h3>
                    <p>
                      Ask an administrator for a project or portfolio grant.
                      Platform access does not automatically include project
                      data.
                    </p>
                  </div>
                )
              )}
              <div className="foundation-note">
                <span className="note-icon" aria-hidden="true">
                  i
                </span>
                <div>
                  <strong>Your evidence workspace starts here</strong>
                  <p>
                    Source connections, delivery checks, follow-ups, and
                    reporting will become available in later increments. No
                    delivery score has been calculated.
                  </p>
                </div>
              </div>
            </>
          )}
        </main>
        <footer>
          Delivery Assurance{" "}
          <span>Evidence first. Every action accountable.</span>
        </footer>
      </div>
    </div>
  );
}
function ProjectDetail({ project }: { project: Project }) {
  return (
    <div className="detail-grid">
      <section className="panel">
        <span className="eyebrow">PROJECT OVERVIEW</span>
        <h2>{project.name}</h2>
        <p className="muted">{project.description}</p>
        <dl>
          <div>
            <dt>Project reference</dt>
            <dd>{project.code}</dd>
          </div>
          <div>
            <dt>Reported status</dt>
            <dd>
              <span className="pill neutral">
                {project.reportedStatus} · Reported, unassessed
              </span>
            </dd>
          </div>
          <div>
            <dt>Evidence freshness</dt>
            <dd>Unknown — no source connected</dd>
          </div>
          <div>
            <dt>Assessed health</dt>
            <dd>Available in the panel below</dd>
          </div>
        </dl>
      </section>
      <section className="panel next-step">
        <span className="eyebrow">CURRENT CHECKS</span>
        <h2>Assess the delivery record</h2>
        <p>
          Run an assessment against the current schedule and source-authorized
          RAID evidence. Missing facts remain unresolved, and reported status
          stays separate from both calculations.
        </p>
        <div className="timeline">
          <span>01</span>
          <div>
            <strong>Workspace & access</strong>
            <small>Foundation available</small>
          </div>
        </div>
        <div className="timeline muted">
          <span>02</span>
          <div>
            <strong>Schedule & blocker age</strong>
            <small>Assessment available below</small>
          </div>
        </div>
        <div className="timeline muted">
          <span>03</span>
          <div>
            <strong>Follow-ups & decisions</strong>
            <small>Planned</small>
          </div>
        </div>
      </section>
    </div>
  );
}
const platformReads = new ManagedReadRegistry(8);
function PlatformView({ actor, request, ownerScope, admissionScope, isCurrentScope }: {
  actor: Actor; request: RequestFn; ownerScope: string; admissionScope: string; isCurrentScope: () => boolean;
}) {
  const active = React.useRef(true), lifecycle = React.useRef(0), statusIssuance = React.useRef(0), auditIssuance = React.useRef(0);
  const statusDeniedRef = React.useRef(false), auditDeniedRef = React.useRef(false);
  const [statusDenied, setStatusDenied] = useState(false), [auditDenied, setAuditDenied] = useState(false);
  const [statusAttempt, setStatusAttempt] = useState(0), [auditAttempt, setAuditAttempt] = useState(0);
  const statusAttemptRef = React.useRef(0), auditAttemptRef = React.useRef(0);
  React.useEffect(() => { active.current = true; if (lifecycle.current) { setStatusAttempt(++statusAttemptRef.current); setAuditAttempt(++auditAttemptRef.current); }
    return () => { active.current = false; lifecycle.current++; client.removeQueries({ queryKey: ["platform-owned", ownerScope] });
      client.removeQueries({ queryKey: ["access-operations-owned", ownerScope] }); }; }, [ownerScope]);
  const statusKey = ["platform-owned", ownerScope, admissionScope, statusAttempt] as const;
  const auditKey = ["access-operations-owned", ownerScope, admissionScope, auditAttempt] as const;
  const status = useProtectedQuery({
    queryKey: statusKey,
    queryFn: async ({ signal }) => {
      const read = ++statusIssuance.current, owner = lifecycle.current;
      const current = () => isCurrentScope() && active.current && !statusDeniedRef.current && statusAttemptRef.current === statusAttempt && lifecycle.current === owner && statusIssuance.current === read;
      const value = await managedRead(platformReads, signal, current, (live, completion) =>
        request<Platform>("/platform", { redirect: "error" }, 65536, (denied) => {
          if (denied && live()) { statusDeniedRef.current = true; setStatusDenied(true); client.removeQueries({ queryKey: ["platform-owned", ownerScope] }); }
        }, { current: live, completion }, live, 200));
      if (!value || typeof value.database !== "string" || typeof value.worker !== "string" || typeof value.shadowMode !== "boolean") throw new Error("Platform status is unavailable.");
      return { value, issuance: read, lifecycle: owner };
    },
    enabled: isCurrentScope() && !statusDenied,
    refetchInterval: 15000,
  });
  const audit = useProtectedQuery({
    queryKey: auditKey,
    queryFn: async ({ signal }) => {
      const read = ++auditIssuance.current, owner = lifecycle.current;
      const current = () => isCurrentScope() && active.current && !auditDeniedRef.current && auditAttemptRef.current === auditAttempt && lifecycle.current === owner && auditIssuance.current === read;
      const value = await managedRead(platformReads, signal, current, (live, completion) =>
        request<unknown>("/access-operations", { redirect: "error" }, 65536, (denied) => {
          if (denied && live()) { auditDeniedRef.current = true; setAuditDenied(true); client.removeQueries({ queryKey: ["access-operations-owned", ownerScope] }); }
        }, { current: live, completion }, live, 200));
      return { value: decodeAccessOperations(value), issuance: read, lifecycle: owner };
    },
    enabled: isCurrentScope() && !auditDenied && actor.roles.includes("system_admin"),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [subject, setSubject] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [scopeType, setScopeType] = useState("project");
  const [role, setRole] = useState("contributor");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = React.useRef(false);
  const draftEpoch = React.useRef(0);
  const [renderedDraftEpoch, setRenderedDraftEpoch] = useState(0);
  const edit = (change: () => void) => { if (!isCurrentScope() || !active.current || busy || operation.current || accessGrantWrites.snapshot() !== renderedAccessVersion || draftEpoch.current !== renderedDraftEpoch) return;
    draftEpoch.current++; setRenderedDraftEpoch(draftEpoch.current); change(); };
  const statusState = client.getQueryState<typeof status.data>(statusKey), auditState = client.getQueryState<typeof audit.data>(auditKey);
  const currentStatus = isCurrentScope() && !statusDeniedRef.current && status.data && statusState?.data === status.data &&
    statusState.status === "success" && statusState.fetchStatus === "idle" && status.data.issuance === statusIssuance.current && status.data.lifecycle === lifecycle.current ? status.data.value : undefined;
  const currentAudit = isCurrentScope() && !auditDeniedRef.current && audit.data && auditState?.data === audit.data &&
    auditState.status === "success" && auditState.fetchStatus === "idle" && audit.data.issuance === auditIssuance.current && audit.data.lifecycle === lifecycle.current ? audit.data.value : undefined;
  const renderedStatusIssuance = statusIssuance.current, renderedAuditIssuance = auditIssuance.current, renderedLifecycle = lifecycle.current;
  const retryStatus = () => {
    const state = client.getQueryState(statusKey);
    if (!isCurrentScope() || statusAttemptRef.current !== statusAttempt || lifecycle.current !== renderedLifecycle ||
      statusIssuance.current !== renderedStatusIssuance ||
      (!statusDeniedRef.current && !(state?.status === "error" && state.fetchStatus === "idle"))) return;
    statusAttemptRef.current++; statusDeniedRef.current = false; setStatusDenied(false); setStatusAttempt(statusAttemptRef.current);
  };
  const retryAudit = () => {
    const state = client.getQueryState(auditKey);
    if (!isCurrentScope() || auditAttemptRef.current !== auditAttempt || lifecycle.current !== renderedLifecycle ||
      auditIssuance.current !== renderedAuditIssuance ||
      (!auditDeniedRef.current && !(state?.status === "error" && state.fetchStatus === "idle"))) return;
    auditAttemptRef.current++; auditDeniedRef.current = false; setAuditDenied(false); setAuditAttempt(auditAttemptRef.current);
  };
  const renderedAccessVersion = React.useSyncExternalStore(accessGrantWrites.subscribe, accessGrantWrites.snapshot, accessGrantWrites.snapshot);
  const writeOwner = accessGrantOwner(actor.customerId, subject, scopeType, scopeId);
  const writeState = accessGrantWrites.state(writeOwner);
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isCurrentScope() || !active.current || busy || operation.current || accessGrantWrites.snapshot() !== renderedAccessVersion ||
      draftEpoch.current !== renderedDraftEpoch || !subject.trim() || !operationUuid.test(scopeId)) return;
    const owner = accessGrantOwner(actor.customerId, subject, scopeType, scopeId);
    const epoch = draftEpoch.current;
    const lease = accessGrantWrites.begin(owner);
    if (!lease) { setMessageError(true); setMessage("An earlier access change is pending or could not be confirmed. Check access before making another change."); return; }
    operation.current = true;
    setBusy(true);
    setMessage("");
    setMessageError(false);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    try {
      await request("/access-grants", {
        method: action === "revoke" ? "DELETE" : "POST",
        body: JSON.stringify({
          subject,
          scopeType,
          scopeId,
          ...(action === "revoke" ? {} : { role }),
        }),
      }, 65536, undefined, undefined, isCurrentScope, 204);
      if (!isCurrentScope() || !active.current || draftEpoch.current !== epoch) { accessGrantWrites.uncertain(owner, lease); return; }
      accessGrantWrites.confirm(owner, lease);
      setMessage(
        action === "revoke"
          ? "Revoke operation recorded."
          : "Grant operation recorded.",
      );
      void client.invalidateQueries({ queryKey: ["access-operations-owned", ownerScope] });
    } catch {
      accessGrantWrites.uncertain(owner, lease);
      if (isCurrentScope() && active.current) { setMessageError(true);
        setMessage("The access change could not be confirmed. Check access before making another change."); }
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="summary-strip">
        <div>
          <span>Database</span>
          <strong className="quiet-value">
            {currentStatus?.database ?? "Checking…"}
          </strong>
        </div>
        <div>
          <span>Background worker</span>
          <strong className="quiet-value">
            {currentStatus?.worker ?? "Checking…"}
          </strong>
        </div>
        <div>
          <span>Outbound actions</span>
          <strong className="quiet-value">
            {currentStatus
              ? currentStatus.shadowMode
                ? "Shadow mode"
                : "Policy controlled"
              : "Checking…"}
          </strong>
        </div>
      </div>
      {(status.error || statusDenied) && (
        <p role="alert" className="error">
          Platform status is unavailable. <Button className="secondary" onClick={retryStatus}>Retry platform status</Button>
        </p>
      )}
      <div className="detail-grid">
        <section className="panel">
          <h2>Manage scoped access</h2>
          <p className="muted">
            Grant access to one project or portfolio using its identifier. Each
            change is recorded.
          </p>
          <form onSubmit={update}>
            <fieldset className="access-grant-fields" disabled={busy}>
            <TextField
              label="Account subject"
              required
              maxLength={200}
              value={subject}
              onChange={(e) => { const value = e.target.value; edit(() => setSubject(value)); }}
              placeholder="Identity provider subject"
            />
            <div className="form-row">
              <SelectField
                label="Scope"
                value={scopeType}
                onChange={(e) => { const value = e.target.value; edit(() => setScopeType(value)); }}
              >
                <option value="project">Project</option>
                <option value="portfolio">Portfolio</option>
              </SelectField>
              <SelectField
                label="Role"
                value={role}
                onChange={(e) => { const value = e.target.value; edit(() => setRole(value)); }}
              >
                {[
                  "contributor",
                  "project_manager",
                  "portfolio_manager",
                  "leadership",
                  "pmo_admin",
                  "system_admin",
                ].map((r) => (
                  <option key={r} value={r}>
                    {r.replaceAll("_", " ")}
                  </option>
                ))}
              </SelectField>
            </div>
            <TextField
              label="Scope identifier"
              required
              value={scopeId}
              onChange={(e) => { const value = e.target.value; edit(() => setScopeId(value)); }}
              placeholder="Project or portfolio UUID"
              pattern="[0-9a-fA-F-]{36}"
            />
            <div className="actions">
              <Button
                type="submit"
                className="primary"
                value="grant"
                disabled={busy || writeState !== "available"}
              >
                Grant access
              </Button>
              <Button
                type="submit"
                className="secondary"
                value="revoke"
                disabled={busy || writeState !== "available"}
              >
                Revoke access
              </Button>
            </div>
            </fieldset>
            {writeState !== "available" && <Message error={writeState !== "pending"}>{writeState === "pending"
              ? "An access change is pending." : "An earlier access change could not be confirmed. Check access before making another change."}</Message>}
            {message && <Message error={messageError}>{message}</Message>}
          </form>
        </section>
        <section className="panel">
          <h2>Recent access operations</h2>
          <p className="muted">
            Up to 30 recorded grant and revoke operations. These records do not
            establish current access. Historical database timestamps may not have a verified time zone.
          </p>
          {!actor.roles.includes("system_admin") ? (
            <p className="muted">Operation history is unavailable for this role.</p>
          ) : auditDenied || audit.error ? (
            <p role="alert" className="error">Access operation history is unavailable. <Button className="secondary" onClick={retryAudit}>Retry operation history</Button></p>
          ) : audit.isFetching ? (
            <p className="muted">Loading operation history…</p>
          ) : currentAudit?.length ? (
            <ul className="audit-list">
              {currentAudit.map((a) => (
                <li key={a.id}>
                  <strong>
                    {a.event === "access.granted"
                      ? "Grant operation recorded"
                      : "Revoke operation recorded"}
                  </strong>
                  <span>{a.actor}</span>
                  <small>Recorded time: {a.occurredAt.replace("T", " ").replace(/Z$/, "")}</small>
                </li>
              ))}
            </ul>
          ) : currentAudit ? (
            <p className="muted">No recorded access operations found.</p>
          ) : (
            <p className="muted">Loading operation history…</p>
          )}
        </section>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
