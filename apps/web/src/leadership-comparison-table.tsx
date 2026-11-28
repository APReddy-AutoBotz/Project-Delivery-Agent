import type { ProjectLeadershipAnswer } from "@pdaa/domain";

type Claim = Extract<ProjectLeadershipAnswer, { state: "COMPARISON" }>["comparisonClaims"][number];

export function LeadershipComparisonTable({ claims, emptyMessage }: { claims: readonly Claim[]; emptyMessage: string }) {
  const current = claims.filter(({ validUntil }) => validUntil === null || Date.parse(validUntil) > Date.now());
  if (!current.length) return <p>{claims.length ? "Comparison evidence has expired." : emptyMessage}</p>;
  return <><table>
    <thead><tr><th scope="col">Fact</th><th scope="col">Saved snapshot</th><th scope="col">Current</th><th scope="col">Evidence</th></tr></thead>
    <tbody>{current.map((claim) => <tr key={claim.field}>
      <th scope="row">{claim.field}</th>
      <td>{claim.before ?? "Unavailable"}</td>
      <td>{claim.after ?? "Unavailable"}</td>
      <td><details><summary>Evidence</summary>{claim.evidenceIds.join(", ")}</details></td>
    </tr>)}</tbody>
  </table>{current.length < claims.length && <p>Some comparison evidence has expired.</p>}</>;
}
