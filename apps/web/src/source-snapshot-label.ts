export function sourceSnapshotLabel(kind: string): string | undefined {
  switch (kind) {
    case "jira.issue": return "Jira issue snapshot";
    case "xlsx.row": return "Reviewed Excel row snapshot";
    default: return undefined;
  }
}
