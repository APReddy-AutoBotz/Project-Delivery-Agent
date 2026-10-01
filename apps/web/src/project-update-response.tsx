import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Message } from "./components.js";
import type { RequestFn } from "./canonical-project.js";
import "./project-update-response.css";

type ResponseEntry = { id: string; submittedBy: string; receivedAt: string;
  correctsResponseId: string | null; state: "UNCONFIRMED"; contentState: "PRESENT" | "EXPIRED"; text: string | null };
type RecipientRequest = { requestId: string; project: { id: string; code: string; name: string };
  stageKind: string; dueAt: string; capturedAt: string; expiresAt: string; body: string;
  rawResponseReaders: string[]; responses: ResponseEntry[] };
type History = { projectId: string; engagement: { id: string; generation: number; policyRevision: number; mode: string } | null;
  nextCursor: string | null; entries: Array<{ requestId: string; stageKind: string; recipientSubject: string;
    capturedAt: string; expiresAt: string; status: string; contentState: string;
    body: string | null; recipientPath: string | null; responses: ResponseEntry[] }> };

function Responses({ entries }: { entries: ResponseEntry[] }) {
  return <ul>{entries.map((entry) => <li key={entry.id}>
    <strong>Unconfirmed response</strong> · {entry.submittedBy} · {entry.receivedAt}
    {entry.correctsResponseId && <p>Correction to an earlier response; both are retained.</p>}
    <p className="update-plain-text">{entry.text ?? "Response content has expired."}</p>
  </li>)}</ul>;
}

export function ProjectUpdateResponse({ locator, request }: { locator: string; request: RequestFn }) {
  const queryClient = useQueryClient();
  const key = ["project-update-invitation", locator];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) =>
    request<RecipientRequest>(`/project-update-invitations/${locator}`, { signal }),
    retry: false, staleTime: 0, refetchOnWindowFocus: true });
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const submission = useRef<{ key: string; text: string; correction: string | null } | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; submission.current = null; }; }, []);
  useEffect(() => {
    if (query.isError) { setText(""); setCorrection(null); submission.current = null; }
  }, [query.isError]);
  useEffect(() => {
    if (!query.data) return;
    const expire = () => { active.current = false; setExpired(true); setText(""); setCorrection(null); submission.current = null;
      queryClient.removeQueries({ queryKey: ["project-update-invitation", locator], exact: true }); };
    const remaining = Date.parse(query.data.expiresAt) - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [query.data, queryClient, locator]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || expired || !query.data || query.isError) return;
    if (!submission.current || submission.current.text !== text || submission.current.correction !== correction)
      submission.current = { key: crypto.randomUUID(), text, correction };
    const command = submission.current;
    setBusy(true); setMessage(""); setFailed(false);
    try {
      await request(`/project-update-invitations/${locator}/responses`, { method: "POST",
        body: JSON.stringify({ text: command.text, idempotencyKey: command.key, correctsResponseId: command.correction }) });
      if (!active.current) return;
      setText(""); setCorrection(null); submission.current = null;
      setMessage("Response recorded; required facts remain unconfirmed.");
      await queryClient.invalidateQueries({ queryKey: ["project-update-invitation", locator] });
    } catch (error) {
      if (!active.current) return;
      setFailed(true);
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) {
        active.current = false;
        setExpired(true); setText(""); setCorrection(null); submission.current = null;
        queryClient.removeQueries({ queryKey: ["project-update-invitation", locator], exact: true });
      }
      setMessage("Your response could not be recorded. Check access or try again.");
    } finally { if (active.current) setBusy(false); }
  }

  if (expired || query.isError) return <Message error>This update request is unavailable or has expired.</Message>;
  if (!query.data) return <Message>Loading update request…</Message>;
  return <section className="panel" aria-label="Respond to update request">
    <h2>{query.data.project.name}: update requested</h2>
    <p className="update-plain-text">{query.data.body}</p>
    <p>Available until {query.data.expiresAt}. Raw responses are shared with: {query.data.rawResponseReaders.join(", ")}.</p>
    <Responses entries={query.data.responses} />
    <form onSubmit={submit}>
      <label className="field"><span>Your update (unconfirmed)</span>
        <textarea required maxLength={8000} rows={6} value={text} disabled={busy}
          onChange={(event) => setText(event.target.value)} aria-describedby="update-response-notice" />
      </label>
      <p id="update-response-notice">Submitting records your response. Required facts remain unconfirmed, reminders continue, and no Jira change is made.</p>
      <label className="field"><span>Correct an earlier response (optional)</span>
        <select value={correction ?? ""} disabled={busy} onChange={(event) => setCorrection(event.target.value || null)}>
          <option value="">New response</option>
          {query.data.responses.map((entry) => <option key={entry.id} value={entry.id}>{entry.receivedAt}</option>)}
        </select>
      </label>
      <Button className="primary" type="submit" disabled={busy || !text.trim() || new TextEncoder().encode(text).length > 16384}>Record response</Button>
      {message && <Message error={failed}>{message}</Message>}
    </form>
  </section>;
}

export function ProjectUpdateCaptureHistory({ projectId, request, pmoAdmin }: { projectId: string; request: RequestFn; pmoAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const query = useQuery({ queryKey: ["project-update-capture-history", projectId, cursor], retry: false,
    queryFn: ({ signal }) => request<History>(`/projects/${projectId}/project-update-capture-history${cursor ? "?cursor=" + cursor : ""}`, { signal }) });
  const data = query.isError ? undefined : query.data;
  const canApprove = data?.engagement?.mode === "SHADOW" ||
    (data?.entries.some((entry) => entry.status === "QUARANTINED") &&
      !data.entries.some((entry) => entry.status === "ACTIVE"));
  async function approveCapture() {
    if (!data?.engagement || busy) return;
    setBusy(true); setMessage("");
    try {
      await request(`/projects/${projectId}/project-update-capture-generations`, { method: "POST",
        body: JSON.stringify({ expectedPolicyRevision: data.engagement.policyRevision,
          expectedEngagementGeneration: data.engagement.generation }) });
      setMessage("Capture generation approved. Requests will be prepared after current access and evidence checks.");
      await queryClient.invalidateQueries({ queryKey: ["project-update-capture-history", projectId] });
    } catch { setMessage("Capture could not be approved. Refresh the policy and capture history before retrying."); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-label="Captured update requests">
    <h3>Captured update requests</h3>
    <p>Requests and unconfirmed responses are retained according to the customer’s content policy.</p>
    {query.isError ? <Message error>Capture history is unavailable for this account.</Message> :
      !data ? <Message>Loading capture history…</Message> : <>
        {data.entries.length === 0 && <p>No captured requests on this page.</p>}
        {data.entries.map((entry) => <article key={entry.requestId}>
          <h4>{entry.stageKind} · {entry.recipientSubject} · {entry.status}</h4>
          {entry.status === "QUARANTINED" && <p>This invitation has been invalidated. Retained content is available to authorized readers.</p>}
          <p>Captured {entry.capturedAt} · Invitation expires {entry.expiresAt}</p>
          <p className="update-plain-text">{entry.body ?? (entry.contentState === "EXPIRED" ? "Request content has expired." : "Content is restricted for this account.")}</p>
          {entry.recipientPath && <a href={entry.recipientPath}>Respond to this request</a>}
          <Responses entries={entry.responses} />
        </article>)}
        <div className="actions">
          {cursor && <Button onClick={() => setCursor(null)}>Newest requests</Button>}
          {data.nextCursor && <Button onClick={() => setCursor(data.nextCursor)}>Older requests</Button>}
          {pmoAdmin && canApprove && <Button disabled={busy} onClick={approveCapture}>Approve a new capture generation</Button>}
        </div>
      </>}
    {message && <Message>{message}</Message>}
  </section>;
}
