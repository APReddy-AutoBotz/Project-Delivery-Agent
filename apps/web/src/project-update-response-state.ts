// NFR-SEC-005: discard protected invitation data when current access is denied.
type InvitationCache = { removeQueries(filter: { queryKey: string[]; exact: true }): void };
export function clearDeniedProjectUpdateInvitation(cache: InvitationCache, locator: string, error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status !== 401 && status !== 403 && status !== 404) return false;
  cache.removeQueries({ queryKey: ["project-update-invitation", locator], exact: true });
  return true;
}
