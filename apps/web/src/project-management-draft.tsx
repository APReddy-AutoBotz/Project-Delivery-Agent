import { useMutation } from "@tanstack/react-query";
import type { ProjectManagementDraftOutput } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { downloadManagementPowerPoint } from "./management-download.js";
import { decodeProjectManagementDraft } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

type DraftAction = { scope: string } & (
  | { action: "preview" | "latest" }
  | { action: "save" | "download"; displayed: ProjectManagementDraftOutput }
);

function DraftSummary({ report }: { report: ProjectManagementDraftOutput }) {
  return <>
    <p>{report.draft.project.name} ({report.draft.project.code})</p>
    <p>Draft · Reporting month {report.draft.reportingPeriod}</p>
    {report.snapshotId && <p>Saved snapshot <strong>{report.snapshotId}</strong></p>}
    <p>Generated {report.draft.asOf} (UTC)</p>
    <ul>{report.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
  </>;
}

export function ProjectManagementDraft({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const preview = useMutation({ mutationFn: async (command: DraftAction) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const download = command.action === "download" ? command.displayed : null;
    const snapshotId = command.action === "latest" ? "latest" : download?.snapshotId;
    const path = `/projects/${projectId}/management-draft${snapshotId ? `?snapshotId=${snapshotId}` : ""}`;
    const init: RequestInit = command.action === "save"
      ? { method: "POST", body: JSON.stringify(command.displayed.draft), cache: "no-store" }
      : { cache: "no-store" };
    const raw = await request(path, init,
      170_000, undefined, undefined, isCurrent);
    const report = decodeProjectManagementDraft(raw, projectId);
    if (!report || !isCurrent() || ((command.action === "save" || command.action === "latest") && !report.snapshotId))
      throw new Error("Project draft unavailable");
    if (download) {
      const reread = download.snapshotId ? report.draft : { ...report.draft, asOf: download.draft.asOf };
      if (report.snapshotId !== download.snapshotId || JSON.stringify(reread) !== JSON.stringify(download.draft))
        throw new Error("The displayed project facts changed");
      downloadManagementPowerPoint(download.powerpointBase64,
        `project-${projectId}-${download.snapshotId ?? download.draft.reportingPeriod}-draft.pptx`);
      return download;
    }
    return report;
  } });
  const current = preview.variables?.scope === scope && isCurrent();
  const report = current && preview.isSuccess ? preview.data : null;
  return <section className="panel" aria-label="Project management draft">
    <h2>Management draft</h2>
    <Button className="secondary" disabled={preview.isPending || !isCurrent()}
      onClick={() => { if (isCurrent()) preview.mutate({ scope, action: "preview" }); }}>Preview management draft</Button>
    <Button className="secondary" disabled={preview.isPending || !isCurrent()}
      onClick={() => { if (isCurrent()) preview.mutate({ scope, action: "latest" }); }}>Open latest saved draft</Button>
    {current && preview.isPending && <p role="status">
      {preview.variables?.action === "download" ? "Checking draft access…" : "Preparing management draft…"}
    </p>}
    {current && preview.isError && <Message error>The management draft is unavailable.</Message>}
    {report && <div aria-live="polite">
      <DraftSummary report={report} />
      <details>
        <summary>Leadership email preview</summary>
        <DraftSummary report={report} />
        <a href={report.livePath}>Open authenticated project</a>
      </details>
      {!report.snapshotId && <Button className="primary" onClick={() => {
        if (isCurrent()) preview.mutate({ scope, action: "save", displayed: report });
      }}>Save snapshot</Button>}
      <Button className="secondary" onClick={() => {
        if (isCurrent()) preview.mutate({ scope, action: "download", displayed: report });
      }}>Download editable PowerPoint</Button>
    </div>}
  </section>;
}
