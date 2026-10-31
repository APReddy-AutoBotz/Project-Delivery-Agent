export type RequestFn = <T>(path: string, init?: RequestInit, maxResponseBytes?: number, onUnavailable?: (denied?: boolean) => void) => Promise<T>;
