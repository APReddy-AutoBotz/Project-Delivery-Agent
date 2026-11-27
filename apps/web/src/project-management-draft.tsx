import { useMutation } from "@tanstack/react-query";
import type { ProjectManagementDraftOutput } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { downloadManagementPowerPoint } from "./management-download.js";
import { decodeProjectManagementDraft } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

function DraftSummary({ report }: { report: ProjectManagementDraftOutput }) {
  return <>
    <p>{report.draft.project.name} ({report.draft.project.code})</p>
    <p>Draft · Reporting month {report.draft.reportingPeriod}</p>
    <p>Generated {report.draft.asOf} (UTC)</p>
    <ul>{report.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
  </>;
}

export function ProjectManagementDraft({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const preview = useMutation({ mutationFn: async ({ download }: {
    scope: string; download?: ProjectManagementDraftOutput;
  }) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const raw = await request(`/projects/${projectId}/management-draft`, { cache: "no-store" },
      170_000, undefined, undefined, isCurrent);
    const report = decodeProjectManagementDraft(raw, projectId);
    if (!report || !isCurrent()) throw new Error("Project draft unavailable");
    if (download) {
      if (JSON.stringify({ ...report.draft, asOf: download.draft.asOf }) !== JSON.stringify(download.draft))
        throw new Error("The displayed project facts changed");
      downloadManagementPowerPoint(download.powerpointBase64,
        `project-${projectId}-${download.draft.reportingPeriod}-draft.pptx`);
      return download;
    }
    return report;
  } });
  const current = preview.variables?.scope === scope && isCurrent();
  const report = current && preview.isSuccess ? preview.data : null;
  return <section className="panel" aria-label="Project management draft">
    <h2>Management draft</h2>
    <Button className="secondary" disabled={preview.isPending || !isCurrent()}
      onClick={() => { if (isCurrent()) preview.mutate({ scope }); }}>Preview management draft</Button>
    {current && preview.isPending && <p role="status">
      {preview.variables?.download ? "Checking draft access…" : "Preparing management draft…"}
    </p>}
    {current && preview.isError && <Message error>The management draft is unavailable.</Message>}
    {report && <div aria-live="polite">
      <DraftSummary report={report} />
      <details>
        <summary>Leadership email preview</summary>
        <DraftSummary report={report} />
        <a href={report.livePath}>Open authenticated project</a>
      </details>
      <Button className="secondary" onClick={() => {
        if (isCurrent()) preview.mutate({ scope, download: report });
      }}>Download editable PowerPoint</Button>
    </div>}
  </section>;
}
