// A tab-local admission limit for the explicitly managed response lifetimes.
// This is not a total browser-network or response-memory bound. Occupied slots
// include indeterminate cleanup, not just requests known to be active. Only a
// vetted transport owner may report EOF or positively established local stream
// termination/no dispatch. A timeout, abort signal or rejected promise alone
// establishes neither; local termination does not prove remote completion or
// that disclosure capture received the complete body.
export type ManagedReadEnd = "eof" | "terminated" | "unknown";
export type ManagedReadLease = Readonly<{ finish: (end: ManagedReadEnd) => void }>;

export class ManagedReadRegistry {
  private readonly active = new Set<symbol>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private notificationPending = false;

  constructor(private readonly limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("Invalid managed read limit");
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = (): number => this.revision;
  readonly count = (): number => this.active.size;
  readonly available = (): number => this.limit - this.active.size;
  readonly full = (): boolean => this.active.size >= this.limit;

  private notify(): void {
    this.revision++;
    // A query can start during React subscription; publish after the current
    // stack while admission itself remains synchronous.
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      for (const listener of [...this.listeners]) {
        try { listener(); }
        catch { queueMicrotask(() => { throw new Error("Managed read subscriber failed"); }); }
      }
    });
  }

  begin(): ManagedReadLease | null {
    if (this.full()) return null;
    const id = Symbol("managed-read");
    this.active.add(id); this.notify();
    let finished = false;
    return {
      finish: (end) => {
        if (finished) return;
        finished = true;
        // An uncertain cleanup permanently consumes capacity in this document.
        // Promise rejection or timeout alone cannot establish a terminal stream.
        if (end !== "eof" && end !== "terminated") return;
        if (this.active.delete(id)) this.notify();
      },
    };
  }
}
