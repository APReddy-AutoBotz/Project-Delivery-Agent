// Client-side display/action fencing for the two health views. This does not
// authorize requests, prove remote cancellation, or detect idle revocation.
type Check = "identity" | "project";
type Ticket = Readonly<{ context: number; sequence: number; check: Check }>;
export type HealthReadTicket = Readonly<{ context: number; view: number }>;
export type HealthWriteLease = Readonly<{ id: symbol; context: number; owner: string }>;

export class HealthScopeFence {
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
  private visible = false;
  private lease?: HealthWriteLease;
  private readonly uncertainOwners = new Set<string>();
  private readonly assessmentCommands = new Map<string, string>();
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
    this.identityPending = false; this.projectPending = false; this.failed = false; this.visible = visible;
    this.abortReads(); this.notify();
  }

  // A project check must follow the current identity check. Any identity
  // refresh invalidates a project proof obtained under the previous identity.
  begin(check: Check): Ticket | null {
    if (!this.visible || (check === "project" && !this.identityReady)) return null;
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

  capture(current: () => boolean): HealthReadTicket | null {
    if (!this.visible || !this.identityReady || !this.projectReady || this.lease || !current()) return null;
    return { context: this.context, view: this.view };
  }

  valid(ticket: HealthReadTicket, current: () => boolean): boolean {
    return this.visible && this.identityReady && this.projectReady && !this.lease &&
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
  beginWrite(ticket: HealthReadTicket, current: () => boolean, owner: string): HealthWriteLease | null {
    if (!this.valid(ticket, current) || this.atCapacity(owner) || this.reads.size !== 0) return null;
    const lease = { id: Symbol("health-write"), context: this.context, owner };
    this.lease = lease; this.view++; this.abortReads(); this.notify();
    return lease;
  }

  assessmentCommand(ticket: HealthReadTicket, current: () => boolean, owner: string, projectId: string, create: () => string): string | null {
    if (!this.valid(ticket, current) || this.atCapacity(owner) || this.reads.size !== 0) return null;
    const resource = JSON.stringify([owner, projectId]), existing = this.assessmentCommands.get(resource);
    if (existing) return existing;
    if (this.assessmentCommands.size >= 64) return null;
    const key = create(); this.assessmentCommands.set(resource, key); return key;
  }

  completeAssessment(lease: HealthWriteLease, current: () => boolean, projectId: string, key: string): void {
    if (!this.validWrite(lease, current)) return;
    const resource = JSON.stringify([lease.owner, projectId]);
    if (this.assessmentCommands.get(resource) === key) this.assessmentCommands.delete(resource);
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
    this.lease = undefined; this.view++; this.abortReads(); this.notify();
  }
}
