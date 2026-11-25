import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AtlasManagementOutput } from "@pdaa/domain";
import { Button, Message } from "./components.js";
import { decodeAtlasManagementOutput } from "./project-update-invitation-decoder.js";
import type { RequestFn } from "./request-types.js";

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
  const available = (report: AtlasManagementOutput | null | undefined) =>
    Boolean(report && Date.parse(report.snapshot.ownerReply.availableUntil) > Date.now());
  const report = isCurrent() && query.isSuccess && !query.isFetching && available(query.data) ? query.data : null;
  const expiry = report?.snapshot.ownerReply.availableUntil;
  useEffect(() => {
    if (!expiry) return;
    const timer = window.setTimeout(() => void refresh(), Math.max(0, Date.parse(expiry) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry, refresh]);

  async function download(expectedId: string) {
    setDownloading(true);
    setDownloadError(false);
    try {
      const current = await refresh();
      const file = current.data;
      if (!isCurrent()) return;
      if (!current.isSuccess || !file || file.snapshot.id !== expectedId || !available(file))
        throw new Error("The displayed Atlas draft is no longer available");
      const bytes = Uint8Array.from(atob(file.powerpointBase64), (char) => char.charCodeAt(0));
      const href = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = `atlas-${file.snapshot.id}.pptx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      if (isCurrent()) setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  return <section className="panel" aria-label="Atlas management snapshot">
    <h2>Management snapshot</h2>
    <Button className="secondary" disabled={!canGenerate || !isCurrent() || query.isFetching || save.isPending || downloading}
      onClick={() => { setDownloadError(false); save.mutate(); }}>Save draft snapshot</Button>
    {save.isPending && <p role="status">Saving Atlas draft…</p>}
    {(query.isError || save.isError || downloadError) && <Message error>The Atlas draft is unavailable.</Message>}
    {report && <div>
      <p>Draft · Synthetic internal · Reporting month {report.snapshot.reportingPeriod}</p>
      <p>Snapshot <strong>{report.snapshot.id}</strong> · Generated {report.snapshot.asOf} (UTC)</p>
      <ul>{report.highlights.map((entry) => <li key={entry}>{entry}</li>)}</ul>
      <details>
        <summary>Leadership email preview</summary>
        <p>Atlas management snapshot for {report.snapshot.reportingPeriod}</p>
        <p>Draft · Synthetic internal · Snapshot {report.snapshot.id} · Generated {report.snapshot.asOf} (UTC)</p>
        <ul>{report.highlights.map((entry) => <li key={entry}>{entry}</li>)}</ul>
        <a href={report.livePath}>Open authenticated Atlas project</a>
      </details>
      <Button className="secondary" disabled={downloading} onClick={() => void download(report.snapshot.id)}>
        Download editable PowerPoint
      </Button>
    </div>}
  </section>;
}
