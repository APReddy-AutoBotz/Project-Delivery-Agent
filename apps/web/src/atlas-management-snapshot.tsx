import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AtlasManagementPreview } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { downloadManagementPowerPoint } from "./management-download.js";
import { decodeAtlasDistributedReport, decodeAtlasDistributionReceipt, decodeAtlasManagementOutput,
  decodeAtlasManagementPreview, decodeAtlasReportReview } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

const approvalLabels = { DRAFT: "Draft", PENDING: "Awaiting PM approval", APPROVED: "Final · Approved", REJECTED: "Rejected" };
const available = (report: AtlasManagementPreview | null | undefined) =>
  Boolean(report && Date.parse(report.snapshot.ownerReply.availableUntil) > Date.now());

function useReportExpiry(expiry: string | undefined, refresh: () => unknown) {
  useEffect(() => {
    if (!expiry) return;
    const timer = window.setTimeout(() => void refresh(), Math.max(0, Date.parse(expiry) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry, refresh]);
}

function AtlasReportSummary({ report }: { report: AtlasManagementPreview }) {
  const { snapshot, highlights } = report;
  return <>
    <p>{approvalLabels[snapshot.approvalState]} · Synthetic internal · Reporting month {snapshot.reportingPeriod}</p>
    <p>Snapshot <strong>{snapshot.id}</strong> · Generated {snapshot.asOf} (UTC)</p>
    {snapshot.approval?.decidedAt && <p>Decision by {snapshot.approval.approver} at {snapshot.approval.decidedAt} (UTC)</p>}
    <ul>{highlights.map((entry) => <li key={entry}>{entry}</li>)}</ul>
  </>;
}

export function AtlasManagementSnapshot({ projectId, scope, request, isCurrent, canGenerate }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean; canGenerate: boolean;
}) {
  const client = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const path = `/projects/${projectId}/atlas-management-snapshot`;
  const key = ["atlas-management-snapshot", projectId, scope] as const;
  const decode = (raw: unknown) => {
    const report = decodeAtlasManagementOutput(raw, projectId);
    if (!report) throw new Error("Invalid Atlas management snapshot");
    return report;
  };
  const query = useQuery({
    queryKey: key, enabled: isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const raw = await request<unknown>(path, undefined, 200_000);
      return raw === null ? null : decode(raw);
    },
  });
  const refresh = query.refetch;
  const save = useMutation({
    mutationFn: async () => decode(await request<unknown>(path, { method: "POST", body: "{}" }, 200_000)),
    onSuccess: (report) => {
      if (isCurrent()) client.setQueryData(key, report);
    },
  });
  const send = useMutation({
    mutationFn: async (snapshotId: string) => {
      const raw = await request(`${path}/approval-request`, {
        method: "POST", body: JSON.stringify({ snapshotId }),
      }, 4096);
      const submitted = decodeAtlasManagementPreview(raw, projectId);
      if (submitted?.snapshot.id !== snapshotId || !submitted.snapshot.approval)
        throw new Error("Atlas approval request could not be verified");
    },
    onSettled: () => isCurrent() ? refresh() : undefined,
  });
  const report = isCurrent() && query.isSuccess && !query.isFetching && available(query.data) ? query.data : null;
  useReportExpiry(report?.snapshot.ownerReply.availableUntil, refresh);

  async function download(expectedId: string) {
    setDownloading(true);
    setDownloadError(false);
    try {
      const current = await refresh();
      const file = current.data;
      if (!isCurrent()) return;
      if (!current.isSuccess || !file || file.snapshot.id !== expectedId || !available(file))
        throw new Error("The displayed Atlas report is no longer available");
      downloadManagementPowerPoint(file.powerpointBase64, `atlas-${file.snapshot.id}.pptx`);
    } catch {
      if (isCurrent()) setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  return <section className="panel" aria-label="Atlas management snapshot">
    <h2>Management snapshot</h2>
    <Button className="secondary" disabled={!canGenerate || !isCurrent() || query.isFetching || save.isPending || send.isPending || downloading}
      onClick={() => { setDownloadError(false); save.mutate(); }}>Save draft snapshot</Button>
    {save.isPending && <p role="status">Saving Atlas draft…</p>}
    {(query.isError || save.isError || downloadError) && <Message error>The Atlas report is unavailable.</Message>}
    {send.isError && <Message error>Could not verify the PM handoff.</Message>}
    {report && <div>
      <AtlasReportSummary report={report} />
      <details>
        <summary>Leadership email preview</summary>
        <p>Atlas management snapshot for {report.snapshot.reportingPeriod}</p>
        <AtlasReportSummary report={report} />
        <a href={report.livePath}>Open authenticated Atlas project</a>
      </details>
      {report.snapshot.approvalState === "DRAFT" && <Button className="primary" disabled={send.isPending || save.isPending || downloading}
        onClick={() => send.mutate(report.snapshot.id)}>Request final approval</Button>}
      {report.snapshot.approvalState === "PENDING" && <Button className="secondary" onClick={() => void refresh()}>
        Check approval status
      </Button>}
      <Button className="secondary" disabled={downloading} onClick={() => void download(report.snapshot.id)}>
        Download editable PowerPoint
      </Button>
    </div>}
  </section>;
}

export function AtlasReportApproval({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const path = `/projects/${projectId}/atlas-report-approval`;
  const review = useQuery({
    queryKey: ["atlas-report-approval", projectId, scope],
    enabled: isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const raw = await request(path, undefined, 4096);
      if (raw === null) return null;
      const report = decodeAtlasReportReview(raw, projectId);
      if (!report) throw new Error("Atlas report review is unavailable");
      return report;
    },
  });
  const refresh = review.refetch;
  const report = isCurrent() && review.isSuccess && !review.isFetching && available(review.data) ? review.data : null;
  useReportExpiry(report?.snapshot.ownerReply.availableUntil, refresh);
  const decide = useMutation({
    mutationFn: async (command: { snapshotId: string; requestId: string; decision: "APPROVED" | "REJECTED" }) => {
      const raw = await request(path, { method: "POST", body: JSON.stringify(command) }, 4096);
      const result = decodeAtlasManagementPreview(raw, projectId)?.snapshot;
      if (result?.id !== command.snapshotId || result.approval?.requestId !== command.requestId ||
          result.approvalState !== command.decision) throw new Error("Atlas decision could not be verified");
    },
    onSettled: () => isCurrent() ? refresh() : undefined,
  });
  const distribute = useMutation({
    mutationFn: async (command: { snapshotId: string; requestId: string }) => {
      const raw = await request(`/projects/${projectId}/atlas-report-distribution`, {
        method: "POST", body: JSON.stringify(command),
      }, 4096);
      const result = decodeAtlasDistributionReceipt(raw);
      if (result?.snapshotId !== command.snapshotId || result.requestId !== command.requestId)
        throw new Error("Atlas report distribution could not be verified");
    },
    onSettled: () => isCurrent() ? refresh() : undefined,
  });
  const approval = report?.snapshot.approval;
  const pending = report?.snapshot.approvalState === "PENDING" && approval;
  return <section className="panel" aria-label="Atlas final report approval">
    <h2>Final report approval</h2>
    {review.isFetching && <p role="status">Checking for a submitted report…</p>}
    {review.isError && <Message error>The Atlas report review is unavailable.</Message>}
    {review.isSuccess && !review.isFetching && !report && <p>No Atlas report submitted for review.</p>}
    {report && <AtlasReportSummary report={report} />}
    {pending && <div className="actions">
      <Button className="primary" disabled={decide.isPending} onClick={() =>
        decide.mutate({ snapshotId: report.snapshot.id, requestId: approval.requestId, decision: "APPROVED" })}>Approve final report</Button>
      <Button className="secondary" disabled={decide.isPending} onClick={() =>
        decide.mutate({ snapshotId: report.snapshot.id, requestId: approval.requestId, decision: "REJECTED" })}>Reject report</Button>
    </div>}
    {approval && report.snapshot.approvalState === "APPROVED" && (report.distribution
      ? <p>Distributed to Atlas Leadership at {report.distribution.distributedAt} (UTC). Receipt {report.distribution.id}.</p>
      : <Button className="primary" disabled={distribute.isPending || decide.isPending} onClick={() =>
        distribute.mutate({ snapshotId: report.snapshot.id, requestId: approval.requestId })}>Distribute to Atlas Leadership</Button>)}
    {decide.isError && <Message error>Could not verify the Atlas report decision.</Message>}
    {distribute.isError && <Message error>Could not verify the Atlas report distribution.</Message>}
  </section>;
}

export function AtlasReportInbox({ projectId, scope, request, isCurrent }: {
  projectId: string; scope: string; request: RequestFn; isCurrent: () => boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const delivery = useQuery({
    queryKey: ["atlas-distributed-report", projectId, scope],
    enabled: isCurrent(), retry: false, refetchOnWindowFocus: "always",
    queryFn: async () => {
      const raw = await request(`/projects/${projectId}/atlas-report-distribution`, undefined, 200_000);
      if (raw === null) return null;
      const report = decodeAtlasDistributedReport(raw, projectId);
      if (!report) throw new Error("Atlas report distribution is unavailable");
      return report;
    },
  });
  const refresh = delivery.refetch;
  const report = isCurrent() && delivery.isSuccess && !delivery.isFetching && available(delivery.data) ? delivery.data : null;
  useReportExpiry(report?.snapshot.ownerReply.availableUntil, refresh);

  async function download(expectedReceiptId: string) {
    setDownloading(true);
    setDownloadError(false);
    try {
      const result = await refresh();
      const file = result.data;
      if (!isCurrent()) return;
      if (!result.isSuccess || file?.distribution.id !== expectedReceiptId || !available(file))
        throw new Error("The distributed Atlas report is unavailable");
      downloadManagementPowerPoint(file.powerpointBase64, `atlas-${file.snapshot.id}.pptx`);
    } catch {
      if (isCurrent()) setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  return <section className="panel" aria-label="Atlas report inbox">
    <h2>Distributed report</h2>
    {delivery.isSuccess && !delivery.isFetching && !report && <p>No approved report has been distributed.</p>}
    {(delivery.isError || downloadError) && <Message error>The distributed Atlas report is unavailable.</Message>}
    {report && <>
      <AtlasReportSummary report={report} />
      <p>Delivered at {report.distribution.distributedAt} (UTC). Receipt {report.distribution.id}.</p>
      <Button className="secondary" disabled={downloading} onClick={() => void download(report.distribution.id)}>
        Download distributed PowerPoint
      </Button>
    </>}
  </section>;
}
