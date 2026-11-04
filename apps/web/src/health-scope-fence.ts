// Client-side display/action fencing for the two health views. This does not
// authorize requests, prove remote cancellation, or detect idle revocation.
import { ManagedReadRegistry } from "./managed-read-registry.js";
type Check = "identity" | "project";
type Ticket = Readonly<{ context: number; sequence: number; check: Check }>;
export type HealthReadTicket = Readonly<{ context: number; view: number }>;
export type HealthWriteLease = Readonly<{ id: symbol; context: number; owner: string }>;

export class HealthScopeFence {
  readonly managedReads = new ManagedReadRegistry();
  private context = 0;
  private view = 0;
  private revision = 0;
  private identitySequence = 0;
  private projectSequence = 0;
  private identityReady = false;
  private projectReady = false;
  private identityPending = false;
  private projectPending = false;
  private failed = false;
  private denied = false;
  private scopeKey?: string;
  private visible = false;
  private lease?: HealthWriteLease;
  private readonly uncertainOwners = new Set<string>();
  private readonly assessmentCommands = new Map<string, string>();
  private readonly assessmentAdmissions = new Map<symbol, { resource: string; key: string; created: boolean; dispatched: boolean }>();
  private readonly reads = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();
  private notificationPending = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = (): number => this.revision;
  readonly contextSnapshot = (): number => this.context;
  readonly writing = (): boolean => this.lease !== undefined;
  readonly reading = (): boolean => this.reads.size !== 0;
  readonly uncertain = (owner: string): boolean => this.uncertainOwners.has(owner);
  readonly atCapacity = (owner: string): boolean => !this.uncertainOwners.has(owner) && this.uncertainOwners.size >= 64;
  readonly hasAssessmentCommand = (owner: string, projectId: string): boolean =>
    this.assessmentCommands.has(JSON.stringify([owner, projectId]));
  readonly assessmentCapacity = (owner: string, projectId: string): boolean =>
    !this.hasAssessmentCommand(owner, projectId) && this.assessmentCommands.size >= 64;
  readonly checkFailed = (): boolean => this.failed;
  readonly denialLatched = (): boolean => this.denied;

  private notify(): void {
    this.revision++;
    // Query functions can start while React is subscribing. Avoid publishing a
    // React update during render while invalidating actions synchronously.
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      for (const listener of this.listeners) listener();
    });
  }

  private abortReads(): void {
    for (const controller of this.reads) controller.abort();
    this.reads.clear();
  }

  // Session, project, navigation and visibility transitions invalidate both
  // freshness proofs. An in-flight write lease is intentionally retained.
  transition(visible: boolean): void {
    this.context++; this.view++;
    this.identitySequence++; this.projectSequence++;
    this.identityReady = false; this.projectReady = false;
    this.identityPending = false; this.projectPending = false; this.failed = this.denied; this.visible = visible;
    this.abortReads(); this.notify();
  }

  // Same-scope visibility transitions do not clear a denial. A new actor,
  // session, role set or project scope, or an explicit retry, can clear it.
  bindScope(key: string): boolean {
    if (this.scopeKey === key) return false;
    this.scopeKey = key; this.denied = false; this.transition(this.visible); return true;
  }
  // An actual selection or session change clears the old binding at the
  // transition itself, even if an intermediate scope never renders.
  switchScope(visible: boolean): void {
    this.scopeKey = undefined; this.denied = false; this.transition(visible);
  }
  retryScope(): void { this.denied = false; this.transition(this.visible); }
  capacityFailure(context: number, current: () => boolean): boolean {
    if (context !== this.context || !this.visible || !current()) return false;
    this.failed = true; this.notify(); return true;
  }
  denyContext(context: number, current: () => boolean): boolean {
    if (context !== this.context || !this.visible || !current()) return false;
    this.denied = true; this.transition(this.visible); return true;
  }

  // A project check must follow the current identity check. Any identity
  // refresh invalidates a project proof obtained under the previous identity.
  begin(check: Check): Ticket | null {
    if (!this.visible || this.denied || (check === "project" && !this.identityReady)) return null;
    this.failed = false;
    this.view++;
    const sequence = check === "identity" ? ++this.identitySequence : ++this.projectSequence;
    if (check === "identity") {
      this.identityReady = false; this.identityPending = true;
      this.projectReady = false; this.projectPending = false; this.projectSequence++;
    } else { this.projectReady = false; this.projectPending = true; }
    this.abortReads(); this.notify();
    return { context: this.context, sequence, check };
  }

  finish(ticket: Ticket | null, success: boolean): boolean {
    if (!ticket || ticket.context !== this.context) return false;
    const current = ticket.check === "identity" ? this.identitySequence : this.projectSequence;
    const pending = ticket.check === "identity" ? this.identityPending : this.projectPending;
    if (ticket.sequence !== current || !pending) return false;
    if (ticket.check === "identity") { this.identityReady = success; this.identityPending = false; }
    else { this.projectReady = success; this.projectPending = false; }
    if (!success) this.failed = true;
    this.notify();
    return true;
  }

  currentCheck(ticket: Ticket | null): boolean {
    if (!ticket || ticket.context !== this.context || !this.visible || this.denied) return false;
    return ticket.check === "identity"
      ? this.identityPending && ticket.sequence === this.identitySequence
      : this.projectPending && ticket.sequence === this.projectSequence;
  }

  capture(current: () => boolean): HealthReadTicket | null {
    if (!this.visible || this.denied || !this.identityReady || !this.projectReady || this.lease || !current()) return null;
    return { context: this.context, view: this.view };
  }

  valid(ticket: HealthReadTicket, current: () => boolean): boolean {
    return this.visible && !this.denied && this.identityReady && this.projectReady && !this.lease &&
      ticket.context === this.context && ticket.view === this.view && current();
  }

  // Track only reads; aborting them says nothing about an already sent write.
  trackRead(ticket: HealthReadTicket, current: () => boolean): { signal: AbortSignal; release: () => void } | null {
    if (!this.valid(ticket, current)) return null;
    const controller = new AbortController(); this.reads.add(controller);
    this.notify();
    return { signal: controller.signal, release: () => { if (this.reads.delete(controller)) this.notify(); } };
  }

  // Start a new coordinated health/policy read batch. Individual queries in
  // that batch must not invalidate one another or start uncoordinated retries.
  refreshReads(): void { this.view++; this.abortReads(); this.notify(); }

  // One App-lifetime in-memory lease is deliberately conservative across both
  // panels, projects and the customer-wide threshold. No cross-tab guarantee.
  beginWrite(ticket: HealthReadTicket, current: () => boolean, owner: string, admission: () => boolean = () => true): HealthWriteLease | null {
    let allowed: boolean;
    try { allowed = admission() === true; } catch { return null; }
    if (!allowed || !this.valid(ticket, current) || this.atCapacity(owner) || this.reads.size !== 0) return null;
    const lease = { id: Symbol("health-write"), context: this.context, owner };
    this.lease = lease; this.view++; this.abortReads(); this.notify();
    return lease;
  }

  beginAssessment(ticket: HealthReadTicket, current: () => boolean, owner: string, projectId: string,
    create: () => string, admission: () => boolean = () => true): { lease: HealthWriteLease; key: string } | null {
    let allowed: boolean;
    try { allowed = admission() === true; } catch { return null; }
    if (!allowed || !this.valid(ticket, current) || this.atCapacity(owner) || this.reads.size !== 0) return null;
    const resource = JSON.stringify([owner, projectId]), existing = this.assessmentCommands.get(resource);
    // A retained command may already have reached the server. Its receipt can
    // expire, so resending even the same key could create another assessment.
    if (existing || this.assessmentCommands.size >= 64) return null;
    let key: string;
    try { key = create(); } catch { return null; }
    if (typeof key !== "string" || !key) return null;
    const lease = this.beginWrite(ticket, current, owner, admission);
    if (!lease) return null;
    if (!existing) {
      try { this.assessmentCommands.set(resource, key); }
      catch { this.finishWrite(lease); return null; }
    }
    try { this.assessmentAdmissions.set(lease.id, { resource, key, created: !existing, dispatched: false }); }
    catch {
      if (!existing && this.assessmentCommands.get(resource) === key) this.assessmentCommands.delete(resource);
      this.finishWrite(lease); return null;
    }
    return { lease, key };
  }

  startAssessment(lease: HealthWriteLease, current: () => boolean, projectId: string, key: string): boolean {
    const admission = this.assessmentAdmissions.get(lease.id);
    if (!this.validWrite(lease, current) || !admission || admission.dispatched ||
      admission.resource !== JSON.stringify([lease.owner, projectId]) || admission.key !== key) return false;
    // Called immediately before invoking the request; after this point retain
    // the command even if transport outcome is ambiguous.
    admission.dispatched = true; return true;
  }

  abandonUnsentAssessment(lease: HealthWriteLease): void {
    if (this.lease !== lease) return;
    const admission = this.assessmentAdmissions.get(lease.id);
    if (!admission || admission.dispatched) return;
    if (admission.created && this.assessmentCommands.get(admission.resource) === admission.key)
      this.assessmentCommands.delete(admission.resource);
    this.assessmentAdmissions.delete(lease.id);
  }

  completeAssessment(lease: HealthWriteLease, current: () => boolean, projectId: string, key: string): void {
    if (!this.validWrite(lease, current)) return;
    const resource = JSON.stringify([lease.owner, projectId]);
    const admission = this.assessmentAdmissions.get(lease.id);
    if (admission?.dispatched && admission.resource === resource && admission.key === key &&
      this.assessmentCommands.get(resource) === key) this.assessmentCommands.delete(resource);
  }

  validWrite(lease: HealthWriteLease, current: () => boolean): boolean {
    return this.lease === lease && lease.context === this.context && this.visible &&
      this.identityReady && this.projectReady && current();
  }

  markWriteUncertain(lease: HealthWriteLease): void {
    if (this.lease === lease) { this.uncertainOwners.add(lease.owner); this.notify(); }
  }

  finishWrite(lease: HealthWriteLease): void {
    if (this.lease !== lease) return;
    this.abandonUnsentAssessment(lease);
    this.assessmentAdmissions.delete(lease.id);
    this.lease = undefined; this.view++; this.abortReads(); this.notify();
  }
}
