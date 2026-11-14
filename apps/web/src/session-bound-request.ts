import type { RequestFn } from "./request-types.js";

// SEC-AUTH-001: a callback retains its issuing session, even if a later
// session happens to use the same token. The underlying request performs its
// own response/body cleanup and exact-session 401 handling.
export function bindSessionRequest(request: RequestFn, current: () => boolean): RequestFn {
  const live = () => { try { return current() === true; } catch { return false; } };
  return async <T>(...args: Parameters<RequestFn>): Promise<T> => {
    if (!live()) {
      // No transport was dispatched, so an already reserved managed slot can
      // be released without claiming anything about a remote response.
      try { args[4]?.completion("terminated"); } catch { /* Preserve the stale failure. */ }
      throw new Error("The session changed before this request started.");
    }
    const [path, init, limit, unavailable, managed, effectsCurrent, expectedStatus] = args;
    const effectsLive = () => {
      if (!live()) return false;
      try { return (!effectsCurrent || effectsCurrent() === true) && live(); } catch { return false; }
    };
    try {
      const value = await request<T>(path, init, limit,
        unavailable ? (denied) => { if (effectsLive()) unavailable(denied); } : undefined,
        managed, effectsLive, expectedStatus);
      if (!live()) throw new Error("The session changed before this request completed.");
      return value;
    } catch (error) {
      // A stale error may contain information from the previous session.
      // eslint-disable-next-line preserve-caught-error
      if (!live()) throw new Error("The session changed before this request completed.");
      throw error;
    }
  };
}
