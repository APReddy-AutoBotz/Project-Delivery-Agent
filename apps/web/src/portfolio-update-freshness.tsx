import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PortfolioUpdateFreshnessPage } from "@pdaa/domain";
import { decodeCreatedProject } from "./canonical-creation-decoder.js";
import { Button, Message } from "./components.js";
import type { RequestFn } from "./request-types.js";

type Fact = { factType: string; label: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const factList = (value: unknown): value is Fact[] => Array.isArray(value) && value.length <= 100 &&
  value.every((fact: unknown) => isObject(fact) && typeof fact.factType === "string" &&
    fact.factType.length <= 96 && typeof fact.label === "string" && fact.label.length <= 160);

function decodePage(value: unknown): PortfolioUpdateFreshnessPage | null {
  if (!isObject(value) || !instant(value.asOf) || !Array.isArray(value.projects) || value.projects.length > 10 ||
      (value.next !== null && !decodeCreatedProject({ id: value.next }))) return null;
  const projects: PortfolioUpdateFreshnessPage["projects"] = [];
  for (const raw of value.projects as unknown[]) {
    if (!isObject(raw) || typeof raw.code !== "string" || raw.code.length > 48 ||
        typeof raw.name !== "string" || raw.name.length > 160 || !isObject(raw.assessment)) return null;
    const identity = decodeCreatedProject({ id: raw.id });
    if (!identity) return null;
    const project = { ...identity, code: raw.code, name: raw.name };
    const { state, lastVerifiedUpdateAt, updateDueAt, openObligation, missing, stale, conflicts } = raw.assessment;
    if (state === "UNCONFIGURED" || state === "UNAVAILABLE") {
      projects.push({ ...project, assessment: { state } });
      continue;
    }
    if ((state !== "CURRENT" && state !== "STALE") || (lastVerifiedUpdateAt !== null && !instant(lastVerifiedUpdateAt)) ||
        (updateDueAt !== null && !instant(updateDueAt)) || !factList(missing) || !factList(stale) || !factList(conflicts)) return null;
    let obligation: { id: string; dueAt: string } | null = null;
    if (openObligation !== null) {
      if (!isObject(openObligation) || !instant(openObligation.dueAt)) return null;
      const found = decodeCreatedProject({ id: openObligation.id });
      if (!found) return null;
      obligation = { ...found, dueAt: openObligation.dueAt };
    }
    projects.push({ ...project, assessment: { state, lastVerifiedUpdateAt, updateDueAt,
      openObligation: obligation, missing, stale, conflicts } });
  }
  if (projects.some((project, index) => index > 0 && projects[index - 1]!.id >= project.id) ||
      (value.next !== null && value.next !== projects.at(-1)?.id)) return null;
  return { asOf: value.asOf, projects, next: typeof value.next === "string" ? value.next : null };
}

function FactNames({ facts }: { facts: Fact[] }) {
  return facts.length ? <ul className="list-disc pl-4">
    {facts.map((fact) => <li key={fact.factType}>{fact.label}</li>)}
  </ul> : <>None</>;
}

function LocalTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function PortfolioUpdateFreshness({ scope, request, isCurrent, openProject }: {
  scope: string;
  request: RequestFn;
  isCurrent: () => boolean;
  openProject: (projectId: string) => void;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors.at(-1);
  const client = useQueryClient();
  const key = ["portfolio-update-freshness", scope, after] as const;
  const result = useQuery({
    queryKey: key, gcTime: 0, refetchOnWindowFocus: "always", retry: false,
    queryFn: async ({ signal }) => {
      const path = `/pmo/portfolio-update-freshness${after ? `?after=${encodeURIComponent(after)}` : ""}`;
      const raw = await request<unknown>(path, { signal }, 1_048_576, undefined, undefined, isCurrent, 200);
      const page = decodePage(raw);
      if (!page || !isCurrent()) throw new Error("Portfolio update freshness is unavailable.");
      return page;
    },
  });
  const page = result.isSuccess && !result.isFetching && isCurrent() ? result.data : undefined;
  const canUsePage = () => {
    const state = client.getQueryState<PortfolioUpdateFreshnessPage>(key);
    return Boolean(isCurrent() && page && state?.status === "success" && state.fetchStatus === "idle" && state.data === page);
  };

  return <section className="panel space-y-3" aria-labelledby="portfolio-freshness-heading">
    <h2 id="portfolio-freshness-heading">Portfolio update freshness</h2>
    {result.isFetching && <Message>Checking portfolio updates…</Message>}
    {result.isError && <div><Message error>Portfolio updates are unavailable.</Message>
      <Button className="secondary" onClick={() => { if (isCurrent()) void result.refetch(); }}>Retry portfolio updates</Button>
    </div>}
    {page && (page.projects.length ? <div className="overflow-x-auto">
      <table className="w-full text-left">
        <caption className="text-left">Assessed <LocalTime value={page.asOf} /></caption>
        <thead><tr>{["Project", "Update freshness", "Missing facts", "Stale facts", "Unresolved conflicts"].map((heading) =>
          <th className="p-2" scope="col" key={heading}>{heading}</th>)}</tr></thead>
        <tbody>{page.projects.map(({ id, name, code, assessment }) => <tr key={id} className="border-t align-top">
          <th className="p-2 space-y-1" scope="row">
            <p>{name}</p>
            <a className="underline" href={`/?project=${id}`} onClick={(event) => {
              if (!canUsePage()) { event.preventDefault(); return; }
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              openProject(id);
            }}>Open {code}</a>
          </th>
          {assessment.state === "UNCONFIGURED" || assessment.state === "UNAVAILABLE"
            ? <td className="p-2" colSpan={4}>{assessment.state === "UNCONFIGURED" ? "Update policy is unconfigured" : "Update assessment unavailable"}</td>
            : <>
              <td className="p-2 space-y-1">
                <p>{assessment.state === "STALE" ? "Stale" : "Current cadence"}</p>
                <p>{assessment.lastVerifiedUpdateAt ? <>Last verified <LocalTime value={assessment.lastVerifiedUpdateAt} /></> : "No verified update date"}</p>
                {assessment.openObligation ? <p>Open update obligation due <LocalTime value={assessment.openObligation.dueAt} /></p>
                  : assessment.updateDueAt && <p>Update due <LocalTime value={assessment.updateDueAt} /></p>}
              </td>
              <td className="p-2"><FactNames facts={assessment.missing} /></td>
              <td className="p-2"><FactNames facts={assessment.stale} /></td>
              <td className="p-2"><FactNames facts={assessment.conflicts} /></td>
            </>}
        </tr>)}</tbody>
      </table>
    </div> : <p>No projects are visible with your portfolio permissions.</p>)}
    {(cursors.length > 1 || page?.next) && <div className="flex gap-2">
      <Button className="secondary" disabled={cursors.length === 1 || result.isFetching} onClick={() => {
        if (isCurrent()) setCursors(cursors.slice(0, -1));
      }}>Previous projects</Button>
      <Button className="secondary" disabled={!page?.next} onClick={() => {
        if (canUsePage() && page?.next) setCursors([...cursors, page.next]);
      }}>Next projects</Button>
    </div>}
  </section>;
}
