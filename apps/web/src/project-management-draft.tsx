import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectManagementDraftOutput, ProjectReportDecision, ProjectReportVersion } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { downloadManagementPowerPoint } from "./management-download.js";
import { decodeProjectManagementDraft } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

type DraftAction = { scope: string } & (
  | { action: "preview" | "latest" | "delivered" }
  | { action: "save" | "download" | "request"; displayed: ProjectManagementDraftOutput }
);

const reportLabels = { DRAFT: "Draft", PENDING: "Awaiting PM approval", APPROVED: "Final · Approved", REJECTED: "Rejected" };

function DraftSummary({ report }: { report: ProjectManagementDraftOutput }) {
  return <>
    <p>{report.draft.project.name} ({report.draft.project.code})</p>
    <p>{reportLabels[report.approval?.state ?? "DRAFT"]} · Reporting month {report.draft.reportingPeriod}</p>
    {report.snapshotId && <p>Saved snapshot <strong>{report.snapshotId}</strong></p>}
    <p>Generated {report.draft.asOf} (UTC)</p>
    {report.approval?.decidedAt && <p>Decision recorded {report.approval.decidedAt} (UTC)</p>}
    {report.delivery && <p>Delivered in-app at {report.delivery.deliveredAt} (UTC). Receipt {report.delivery.id}</p>}
    <ul>{report.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    {report.digestHighlights && <>
      <h3>Changes and open decisions</h3>
      <ul>{report.digestHighlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    </>}
  </>;
}

export function ProjectManagementDraft({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const preview = useMutation({ mutationFn: async (command: DraftAction) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const download = command.action === "download" ? command.displayed : null;
    const snapshotId = command.action === "latest" || command.action === "delivered" ? command.action : download?.snapshotId;
    const suffix = command.action === "request" ? "/approval-request" : snapshotId ? `?snapshotId=${snapshotId}` : "";
    const path = `/projects/${projectId}/management-draft${suffix}`;
    const init: RequestInit = command.action === "save"
      ? { method: "POST", body: JSON.stringify(command.displayed.draft), cache: "no-store" }
      : command.action === "request" ? { method: "POST", body: JSON.stringify({ snapshotId: command.displayed.snapshotId }) }
        : { cache: "no-store" };
    const raw = await request(path, init,
      170_000, undefined, undefined, isCurrent);
    const report = decodeProjectManagementDraft(raw, projectId);
    if (!report || !isCurrent() || ((command.action === "save" || command.action === "latest") && !report.snapshotId))
      throw new Error("Project draft unavailable");
    if (command.action === "delivered" && !report.delivery)
      throw new Error("Delivered report unavailable");
    if (command.action === "request" && (report.snapshotId !== command.displayed.snapshotId || !report.approval))
      throw new Error("Report approval request unavailable");
    if (download) {
      const reread = download.snapshotId ? report.draft : { ...report.draft, asOf: download.draft.asOf };
      if (report.snapshotId !== download.snapshotId || JSON.stringify(reread) !== JSON.stringify(download.draft) ||
          JSON.stringify(report.approval) !== JSON.stringify(download.approval) ||
          JSON.stringify(report.delivery) !== JSON.stringify(download.delivery))
        throw new Error("The displayed project facts changed");
      const status = download.approval?.state === "APPROVED" ? "approved" : "draft";
      downloadManagementPowerPoint(download.powerpointBase64,
        `project-${projectId}-${download.snapshotId ?? download.draft.reportingPeriod}-${status}.pptx`);
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
    <Button className="secondary" disabled={preview.isPending || !isCurrent()}
      onClick={() => { if (isCurrent()) preview.mutate({ scope, action: "delivered" }); }}>Open delivered report</Button>
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
      {report.snapshotId && !report.approval && <Button className="primary" onClick={() => {
        if (isCurrent()) preview.mutate({ scope, action: "request", displayed: report });
      }}>Request PM approval</Button>}
      <Button className="secondary" onClick={() => {
        if (isCurrent()) preview.mutate({ scope, action: "download", displayed: report });
      }}>Download editable PowerPoint</Button>
    </div>}
  </section>;
}

export function ProjectReportApproval({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [opened, setOpened] = useState(false);
  const client = useQueryClient();
  const path = `/projects/${projectId}/management-report-approval`;
  const key = ["project-report-approval", projectId, scope] as const;
  const review = useQuery({ queryKey: key, enabled: opened && isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const raw = await request(path, undefined, 170_000, undefined, undefined, isCurrent);
      if (raw === null) return null;
      const report = decodeProjectManagementDraft(raw, projectId);
      if (!report?.snapshotId || !report.approval || !isCurrent()) throw new Error("Report review unavailable");
      return report;
    },
  });
  const manage = useMutation({ mutationFn: async (command: ProjectReportDecision | ProjectReportVersion) => {
    if (!isCurrent()) throw new Error("Project access changed");
    const decision = "decision" in command ? command.decision : null;
    const raw = await request(decision ? path : path + "/delivery", { method: "POST", body: JSON.stringify(command) },
      170_000, undefined, undefined, isCurrent);
    const report = decodeProjectManagementDraft(raw, projectId);
    if (!isCurrent() || report?.snapshotId !== command.snapshotId ||
        report.approval?.requestId !== command.requestId || (decision ? report.approval.state !== decision : !report.delivery))
      throw new Error("Report action unavailable");
    return report;
  }, onSuccess: (report) => {
    if (isCurrent()) {
      client.setQueryData(key, report);
      void review.refetch();
    }
  },
    onError: () => isCurrent() ? review.refetch() : undefined,
  });
  const report = opened && isCurrent() && review.isSuccess && !review.isFetching && !manage.isPending ? review.data : null;
  const version = report?.snapshotId && report.approval ? { snapshotId: report.snapshotId, requestId: report.approval.requestId } : null;
  return <section className="panel" aria-label="Project report approval">
    <h2>Management report approval</h2>
    <Button className="secondary" disabled={review.isFetching || manage.isPending || !isCurrent()} onClick={() => {
      if (!isCurrent()) return;
      if (opened) void review.refetch();
      else setOpened(true);
    }}>Check report approvals</Button>
    {opened && review.isFetching && <p role="status">Checking report access…</p>}
    {opened && review.isSuccess && !review.isFetching && review.data === null && <p>No report is available for your review.</p>}
    {opened && (review.isError || manage.isError) && <Message error>The report review is unavailable.</Message>}
    {opened && manage.isPending && <p role="status">
      {manage.variables && "decision" in manage.variables ? "Recording your decision…" : "Delivering approved report…"}
    </p>}
    {opened && isCurrent() && manage.isSuccess && manage.variables && !("decision" in manage.variables) && manage.data?.delivery &&
      <p role="status">Delivery recorded. Receipt {manage.data.delivery.id}</p>}
    {report && <DraftSummary report={report} />}
    {version && report?.approval?.state === "PENDING" && <>
      <Button className="primary" onClick={() => {
        if (isCurrent()) manage.mutate({ ...version, decision: "APPROVED" });
      }}>Approve saved report</Button>
      <Button className="secondary" onClick={() => {
        if (isCurrent()) manage.mutate({ ...version, decision: "REJECTED" });
      }}>Reject saved report</Button>
    </>}
    {version && report?.approval?.state === "APPROVED" && !report.delivery &&
      <Button className="primary" onClick={() => {
        if (isCurrent()) manage.mutate(version);
      }}>Deliver to requesting leader</Button>}
  </section>;
}
