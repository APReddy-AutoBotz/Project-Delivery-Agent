import { decodeWireIdentity } from "./identity-decoder.js";

// Unwired state model for a future protected request boundary. This does not
// authorize the existing application or replace server-side checks. Credential
// accessors are for a future trusted synchronous dispatcher, never children or
// async callbacks; the caller must separately verify an endpoint's project ID.
export type SessionIdentity = Readonly<{ customerId: string; subject: string; roles: readonly string[] }>;
type Login = Readonly<{ id: symbol }>;
export type Session = Readonly<{ id: symbol }>;
export type IdentityCheck = Readonly<{ session: Session; sequence: number }>;
export type ProtectedCapability = Readonly<{ session: Session; identity: number }>;
export type ProjectCheck = Readonly<{ capability: ProtectedCapability; projectId: string; selection: number; sequence: number }>;
export type ProjectCapability = Readonly<{ capability: ProtectedCapability; projectId: string; selection: number; sequence: number }>;
export type QueueView = Readonly<{ capability: ProtectedCapability; id: symbol }>;
export type QueueIdle = Readonly<{ id: symbol }>;
export type QueueCheck = Readonly<{ view: QueueView; sequence: number }>;
export type QueueCapability = Readonly<{ view: QueueView; sequence: number }>;
export type PreviewIdle = Readonly<{ id: symbol }>;
export type PreviewRowCapability = Readonly<{ projectId: string; turn: number }>;
export type PreviewTurn = Readonly<{ rows: readonly PreviewRowCapability[] }>;
type Outcome = "success" | "denied" | "unavailable";
const wireUuid = (value: unknown): value is string => typeof value === "string" &&
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);
const queueUuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export class ProtectedSessionModel {
  private login?: Login;
  private session?: Session;
  private credential?: string;
  private identitySequence = 0;
  private identityPending = false;
  private identityReady = false;
  private identityCheck?: IdentityCheck;
  private issuedCapability?: ProtectedCapability;
  private identity?: SessionIdentity;
  private selected: string | null = null;
  private selection = 0;
  private projectSequence = 0;
  private projectPending = false;
  private projectReady = false;
  private projectDenied = false;
  private projectCheck?: ProjectCheck;
  private issuedProject?: ProjectCapability;
  private queueSequence = 0;
  private queueView?: QueueView;
  private queueIdle: QueueIdle = Object.freeze({ id: Symbol("queue-idle") });
  private queueCheck?: QueueCheck;
  private issuedQueue?: QueueCapability;
  private queueProjects = new Set<string>();
  private previewSequence = 0;
  private previewIdle: PreviewIdle = Object.freeze({ id: Symbol("preview-idle") });
  private previewTurn?: PreviewTurn;
  private previewRows = new Set<PreviewRowCapability>();

  private clearQueue(): void {
    this.queueSequence++; this.queueCheck = undefined; this.issuedQueue = undefined;
    this.queueIdle = Object.freeze({ id: Symbol("queue-idle") });
    this.queueProjects.clear(); this.previewSequence++; this.previewTurn = undefined; this.previewRows.clear();
    this.previewIdle = Object.freeze({ id: Symbol("preview-idle") });
  }
  private clearQueueView(): void { this.clearQueue(); this.queueView = undefined; }

  private clearSession(): void {
    this.clearQueueView();
    this.session = undefined; this.credential = undefined;
    this.identitySequence++; this.identityPending = false; this.identityReady = false; this.identity = undefined;
    this.identityCheck = undefined; this.issuedCapability = undefined;
    this.selected = null; this.selection++; this.projectSequence++;
    this.projectPending = false; this.projectReady = false; this.projectDenied = false; this.projectCheck = undefined; this.issuedProject = undefined;
  }

  beginLogin(): Login {
    this.clearSession();
    const login = Object.freeze({ id: Symbol("login") }); this.login = login; return login;
  }
  establish(login: Login, credential: string): Session | null {
    if (!this.login || !login || this.login !== login || typeof credential !== "string" || credential.length === 0) return null;
    this.login = undefined;
    const session = Object.freeze({ id: Symbol("session") });
    this.session = session; this.credential = credential; return session;
  }
  signOut(): void { this.login = undefined; this.clearSession(); }
  expire(session: Session): boolean {
    if (!this.session || !session || this.session !== session) return false;
    this.signOut(); return true;
  }

  beginIdentity(session: Session): IdentityCheck | null {
    if (!this.session || !session || this.session !== session) return null;
    this.clearQueueView();
    this.identityReady = false; this.identityPending = true; this.identitySequence++; this.issuedCapability = undefined;
    this.projectReady = false; this.projectPending = false; this.projectSequence++; this.projectCheck = undefined; this.issuedProject = undefined;
    const check = Object.freeze({ session, sequence: this.identitySequence }); this.identityCheck = check; return check;
  }
  identityCredential(check: IdentityCheck): string | undefined {
    return this.currentIdentity(check) ? this.credential : undefined;
  }
  private currentIdentity(check: IdentityCheck): boolean {
    return Boolean(this.identityCheck && check && this.identityCheck === check && this.session === check.session && this.identityPending && check.sequence === this.identitySequence);
  }
  finishIdentity(check: IdentityCheck, outcome: Outcome, actor?: SessionIdentity): "applied" | "stale" | "terminated" {
    if (!this.currentIdentity(check)) return "stale";
    if (outcome === "denied") { this.signOut(); return "terminated"; }
    let decoded: SessionIdentity | undefined;
    try { if (outcome === "success") decoded = decodeWireIdentity(actor); }
    catch { /* Untrusted getters and malformed data fail closed. */ }
    // Parsing can invoke user-controlled accessors. A newer issuance or
    // session may have appeared while validation was in progress.
    if (!this.currentIdentity(check)) return "stale";
    this.identityPending = false; this.identityCheck = undefined;
    if (!decoded) { this.identityReady = false; return "applied"; }
    const normalized = [...decoded.roles].sort();
    const changed = this.identity && (this.identity.customerId !== decoded.customerId || this.identity.subject !== decoded.subject ||
      this.identity.roles.length !== normalized.length || this.identity.roles.some((role, index) => role !== normalized[index]));
    if (changed) { this.selection++; this.projectSequence++; this.projectDenied = false; }
    this.identity = Object.freeze({ customerId: decoded.customerId, subject: decoded.subject, roles: Object.freeze(normalized) });
    this.identityReady = true; this.issuedCapability = Object.freeze({ session: check.session, identity: this.identitySequence }); return "applied";
  }
  capability(session: Session): ProtectedCapability | null {
    return this.session && session && this.session === session && this.identityReady && !this.identityPending ? this.issuedCapability ?? null : null;
  }
  current(capability: ProtectedCapability): boolean {
    return Boolean(this.issuedCapability && capability && this.issuedCapability === capability && this.session === capability.session && this.identityReady && !this.identityPending && capability.identity === this.identitySequence);
  }
  // The immutable value is an as-of snapshot. Retaining it does not retain
  // authority; callers must recheck its exact capability before any action.
  actorSnapshot(capability: ProtectedCapability): SessionIdentity | null {
    return this.current(capability) ? this.identity ?? null : null;
  }
  protectedCredential(capability: ProtectedCapability): string | undefined {
    return this.current(capability) ? this.credential : undefined;
  }

  select(capability: ProtectedCapability, projectId: string | null): boolean {
    if (!this.current(capability) || (projectId !== null && !wireUuid(projectId))) return false;
    if (this.selected !== projectId) {
      this.clearQueueView();
      this.selected = projectId; this.selection++; this.projectSequence++;
      this.projectReady = false; this.projectPending = false; this.projectDenied = false; this.projectCheck = undefined; this.issuedProject = undefined;
    }
    return true;
  }
  beginProject(capability: ProtectedCapability): ProjectCheck | null {
    if (!this.current(capability) || !this.selected || this.projectDenied) return null;
    this.projectReady = false; this.projectPending = true; this.projectSequence++; this.issuedProject = undefined;
    const check = Object.freeze({ capability, projectId: this.selected, selection: this.selection, sequence: this.projectSequence });
    this.projectCheck = check; return check;
  }
  currentProject(check: ProjectCheck): boolean {
    return Boolean(this.projectCheck && check && this.projectCheck === check && this.current(check.capability) && this.selected === check.projectId && this.selection === check.selection &&
      this.projectPending && this.projectSequence === check.sequence);
  }
  finishProject(check: ProjectCheck, outcome: Outcome): boolean {
    if (!this.currentProject(check)) return false;
    this.projectPending = false; this.projectCheck = undefined; this.projectReady = outcome === "success";
    if (outcome === "denied") this.projectDenied = true;
    if (outcome === "success") this.issuedProject = Object.freeze({ capability: check.capability, projectId: check.projectId, selection: check.selection, sequence: check.sequence });
    return true;
  }
  retryProject(capability: ProtectedCapability): boolean {
    if (!this.current(capability) || !this.selected) return false;
    this.projectDenied = false; this.projectReady = false; this.projectPending = false; this.projectSequence++; this.projectCheck = undefined; this.issuedProject = undefined; return true;
  }
  projectCapability(capability: ProtectedCapability): ProjectCapability | null {
    return this.current(capability) && this.issuedProject && this.currentProjectCapability(this.issuedProject) ? this.issuedProject : null;
  }
  currentProjectCapability(capability: ProjectCapability): boolean {
    return Boolean(this.issuedProject && capability && this.issuedProject === capability && this.current(capability.capability) &&
      this.selected === capability.projectId && this.selection === capability.selection && this.projectSequence === capability.sequence &&
      this.projectReady && !this.projectPending && !this.projectDenied);
  }
  projectCredential(capability: ProjectCapability): string | undefined {
    return this.currentProjectCapability(capability) ? this.credential : undefined;
  }
  denyProject(capability: ProjectCapability): boolean {
    if (!this.currentProjectCapability(capability)) return false;
    this.projectDenied = true; this.projectReady = false; this.projectSequence++; this.issuedProject = undefined; return true;
  }

  // Unwired queue/preview model: membership constrains presentation, never
  // grants project access. A future trusted dispatcher must independently
  // enforce exact endpoints, session binding and server-side authorization.
  // Only the trusted synchronous navigation owner may enter/leave a view;
  // request callbacks receive a view handle, never this controller operation.
  enterQueueView(capability: ProtectedCapability): QueueView | null {
    if (!this.current(capability) || this.selected !== null || !this.identity?.roles.includes("project_manager")) return null;
    this.clearQueueView();
    this.queueView = Object.freeze({ capability, id: Symbol("queue-view") }); return this.queueView;
  }
  currentQueueView(view: QueueView): boolean {
    return Boolean(this.queueView && view && this.queueView === view && this.current(view.capability) && this.selected === null);
  }
  leaveQueueView(view: QueueView): boolean {
    if (!this.currentQueueView(view)) return false;
    this.clearQueueView(); return true;
  }
  // Only the trusted owner snapshots idle tokens; stale callbacks keep their
  // issued token and cannot obtain a later vacant generation.
  queueIdleFor(view: QueueView): QueueIdle | null {
    return this.currentQueueView(view) && !this.queueCheck && !this.issuedQueue ? this.queueIdle : null;
  }
  beginQueue(view: QueueView, expected: QueueCheck | QueueCapability | QueueIdle): QueueCheck | null {
    if (!this.currentQueueView(view) || (this.queueCheck ?? this.issuedQueue ?? this.queueIdle) !== expected) return null;
    this.clearQueue();
    const check = Object.freeze({ view, sequence: this.queueSequence }); this.queueCheck = check; return check;
  }
  currentQueueCheck(check: QueueCheck): boolean {
    return Boolean(this.queueCheck && check && this.queueCheck === check && this.currentQueueView(check.view) && check.sequence === this.queueSequence);
  }
  finishQueue(check: QueueCheck, value: unknown): QueueCapability | null {
    if (!this.currentQueueCheck(check)) return null;
    const ids: string[] = [];
    try {
      if (!Array.isArray(value)) throw new Error("invalid queue");
      const count = value.length;
      if (!Number.isSafeInteger(count) || count < 0 || count > 25) throw new Error("invalid queue");
      const seen = new Set<string>();
      for (let index = 0; index < count; index++) {
        if (!Object.hasOwn(value, index)) throw new Error("invalid queue");
        const id: unknown = value[index];
        if (!queueUuid(id) || seen.has(id.toLowerCase())) throw new Error("invalid queue");
        seen.add(id.toLowerCase()); ids.push(id);
      }
    } catch { if (this.currentQueueCheck(check)) this.clearQueue(); return null; }
    if (!this.currentQueueCheck(check)) return null;
    this.queueCheck = undefined; this.queueProjects = new Set(ids);
    this.issuedQueue = Object.freeze({ view: check.view, sequence: check.sequence }); return this.issuedQueue;
  }
  currentQueue(queue: QueueCapability): boolean {
    return Boolean(this.issuedQueue && queue && this.issuedQueue === queue && this.currentQueueView(queue.view) && queue.sequence === this.queueSequence);
  }
  invalidateQueue(expected: QueueCheck | QueueCapability): boolean {
    if (!expected || (this.queueCheck ?? this.issuedQueue) !== expected) return false;
    if (this.queueCheck ? !this.currentQueueCheck(this.queueCheck) : !this.issuedQueue || !this.currentQueue(this.issuedQueue)) return false;
    this.clearQueue(); return true;
  }
  previewIdleFor(queue: QueueCapability): PreviewIdle | null {
    return this.currentQueue(queue) && !this.previewTurn ? this.previewIdle : null;
  }
  beginPreview(queue: QueueCapability, expected: PreviewTurn | PreviewIdle, value: unknown): PreviewTurn | null {
    if (!this.currentQueue(queue) || (this.previewTurn ?? this.previewIdle) !== expected) return null;
    const turn = ++this.previewSequence; this.previewTurn = undefined; this.previewRows.clear();
    this.previewIdle = Object.freeze({ id: Symbol("preview-idle") });
    const ids: string[] = [];
    try {
      if (!Array.isArray(value)) throw new Error("invalid preview");
      const count = value.length;
      if (!Number.isSafeInteger(count) || count < 0 || count > 5) throw new Error("invalid preview");
      const seen = new Set<string>();
      for (let index = 0; index < count; index++) {
        if (!Object.hasOwn(value, index)) throw new Error("invalid preview");
        const id: unknown = value[index];
        // The existing preview decoder requires lower-case versioned UUIDs.
        if (!wireUuid(id) || id !== id.toLowerCase() || !this.queueProjects.has(id) || seen.has(id)) throw new Error("invalid preview");
        seen.add(id); ids.push(id);
      }
    } catch { return null; }
    if (!this.currentQueue(queue) || this.previewSequence !== turn) return null;
    const rows = ids.map((projectId) => Object.freeze({ projectId, turn }));
    this.previewRows = new Set(rows); this.previewTurn = Object.freeze({ rows: Object.freeze(rows) }); return this.previewTurn;
  }
  currentPreviewTurn(queue: QueueCapability, turn: PreviewTurn): boolean {
    return Boolean(this.currentQueue(queue) && this.previewTurn && turn && this.previewTurn === turn);
  }
  currentPreviewRow(queue: QueueCapability, turn: PreviewTurn, row: PreviewRowCapability): boolean {
    return Boolean(this.currentPreviewTurn(queue, turn) && row &&
      this.previewRows.has(row) && row.turn === this.previewSequence);
  }
  cancelPreview(queue: QueueCapability, expected: PreviewTurn | PreviewIdle): boolean {
    if (!this.currentQueue(queue) || !expected || (this.previewTurn ?? this.previewIdle) !== expected) return false;
    this.previewSequence++; this.previewTurn = undefined; this.previewRows.clear();
    this.previewIdle = Object.freeze({ id: Symbol("preview-idle") }); return true;
  }
}
