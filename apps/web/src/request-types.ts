import type { ManagedReadEnd } from "./managed-read-registry.js";

// Only explicitly managed read adapters supply this policy. Existing callers
// retain their prior cancellation and response handling semantics.
export type ManagedRequestPolicy = {
  current: () => boolean;
  completion: (end: ManagedReadEnd) => void;
};
export type RequestFn = <T>(path: string, init?: RequestInit, maxResponseBytes?: number, onUnavailable?: (denied?: boolean) => void, managed?: ManagedRequestPolicy, sideEffectCurrent?: () => boolean, expectedStatus?: number) => Promise<T>;
