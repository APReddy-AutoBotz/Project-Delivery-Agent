import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Message, TextField } from "./components.js";
import type { RequestFn } from "./canonical-project.js";

type RequiredFact = { factType: string; label: string };
type Policy = {
  projectId: string;
  revision: number;
  freshnessWindowSeconds: number;
  timeZone: string;
  requiredFacts: RequiredFact[];
  responsibleSubject: string;
  scheduledScanEnabled: boolean;
};
type FactState = RequiredFact & {
  state: "CONFIRMED" | "MISSING" | "UNCONFIRMED";
  reasonCodes: string[];
};
type Preview = {
  id: string;
  revision: number;
  createdAt: string;
  project: { id: string; code: string; name: string };
  reportedStatus: string;
  policyRevision: number;
  assessedAt: string;
  freshnessThresholdAt: string;
  sourceDateField: string;
  sourceDate: string;
  timestampBasis: string;
  completenessState: "COMPLETE" | "INCOMPLETE";
  freshnessState: "CURRENT" | "STALE";
  requiredFacts: FactState[];
  evidence: Array<{
    factType: string;
    timestampBasis: string;
    observedAt: string;
    effectiveAt: string;
  }>;
};
type Assessment = {
  project: { id: string; code: string; name: string; reportedStatus: string };
  assessedAt: string;
  policy: Policy;
  completeness: {
    state: "COMPLETE" | "INCOMPLETE";
    confirmedCount: number;
    requiredCount: number;
    factAssessments: FactState[];
  };
  freshness: {
    state: "CURRENT" | "STALE";
    sourceDateField: string;
    sourceDate: string;
    freshnessWindowSeconds: number;
    exceededByMilliseconds: number;
  };
  obligation: { id: string; state: "OPEN" | "SUPERSEDED"; dueAt: string } | null;
  preview: Preview | null;
};

export function ProjectUpdates({
  projectId,
  reportedStatus,
  request,
  pmoAdmin,
  visible,
}: {
  projectId: string;
  reportedStatus: string;
  request: RequestFn;
  pmoAdmin: boolean;
  visible: boolean;
}) {
  const queryClient = useQueryClient();
  const policyQuery = useQuery({
    queryKey: ["project-update-policy", projectId],
    queryFn: () => request<Policy | null>(`/projects/${projectId}/project-update-policy`),
    enabled: visible,
    retry: false,
  });
  const latestQuery = useQuery({
    queryKey: ["project-update-latest", projectId],
    queryFn: () => request<Assessment | null>(`/projects/${projectId}/project-update-assessments/latest`),
    enabled: visible,
    retry: false,
  });
  const [windowSeconds, setWindowSeconds] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [owner, setOwner] = useState("");
  const [requiredFactsText, setRequiredFactsText] = useState("");
  const [scheduledScanEnabled, setScheduledScanEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    const policy = policyQuery.data;
    if (!policy) return;
    setWindowSeconds(String(policy.freshnessWindowSeconds));
    setTimeZone(policy.timeZone);
    setOwner(policy.responsibleSubject);
    setRequiredFactsText(
      policy.requiredFacts.map((fact) => `${fact.factType} | ${fact.label}`).join("\n"),
    );
    setScheduledScanEnabled(policy.scheduledScanEnabled);
  }, [policyQuery.data]);

  const rows = requiredFactsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requiredFacts = rows.map((line) => {
    const separator = line.indexOf("|");
    return separator < 0
      ? { factType: line.trim(), label: "" }
      : { factType: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() };
  });

  async function savePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const payload = {
        expectedRevision: policyQuery.data?.revision ?? 0,
        freshnessWindowSeconds: Number(windowSeconds),
        timeZone: timeZone.trim(),
        requiredFacts,
        responsibleSubject: owner.trim(),
        scheduledScanEnabled,
      };
      const saved = await request<Policy>(
        `/projects/${projectId}/project-update-policy`,
        { method: "POST", body: JSON.stringify(payload) },
      );
      queryClient.setQueryData(["project-update-policy", projectId], saved);
      setMessage("Reporting policy saved as an immutable revision.");
    } catch (error) {
      setIsError(true);
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function assess() {
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      await request<Assessment>(
        `/projects/${projectId}/project-update-assessments`,
        { method: "POST", body: "{}" },
      );
      await queryClient.invalidateQueries({
        queryKey: ["project-update-latest", projectId],
      });
      setMessage("Assessment saved. Any request preview remains a draft and has not been sent.");
    } catch (error) {
      setIsError(true);
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel project-updates" aria-label="Project update freshness and completeness">
      <div className="section-heading">
        <div>
          <span className="eyebrow">FRESHNESS & COMPLETENESS</span>
          <h2>Project update</h2>
        </div>
        <Button className="primary" onClick={assess} disabled={busy || !policyQuery.data}>
          Assess project
        </Button>
      </div>
      <p className="muted">
        Source authority controls which facts count. Reported status is shown separately from verified evidence.
        Assessments never write project facts, and request previews are saved as drafts only.
      </p>
      {policyQuery.error && <p role="alert" className="error">{policyQuery.error.message}</p>}
      {latestQuery.error && <p role="alert" className="error">{latestQuery.error.message}</p>}
      {latestQuery.data && (
        <div className="summary-strip">
          <div><span>Reported status</span><strong>{reportedStatus}</strong></div>
          <div><span>Required facts</span><strong>{latestQuery.data.completeness.confirmedCount}/{latestQuery.data.completeness.requiredCount} confirmed</strong></div>
          <div><span>Freshness</span><strong>{latestQuery.data.freshness.state}</strong></div>
          <div><span>Assessed</span><strong>{new Date(latestQuery.data.assessedAt).toLocaleString()}</strong></div>
        </div>
      )}
      {latestQuery.data && (
        <ul className="audit-list">
          {latestQuery.data.completeness.factAssessments.map((fact) => (
            <li key={fact.factType}>
              <strong>{fact.label}</strong>
              <span>{fact.factType}</span>
              <small>{fact.state}{fact.reasonCodes.length ? ` · ${fact.reasonCodes.join(", ")}` : ""}</small>
            </li>
          ))}
        </ul>
      )}
      {latestQuery.data?.preview && (
        <div className="callout">
          <h3>Saved request preview · Draft</h3>
          <p>
            Project {latestQuery.data.preview.project.code}: {latestQuery.data.preview.project.name}.
            Reported status: {latestQuery.data.preview.reportedStatus}.
          </p>
          <p>
            Update date: {latestQuery.data.preview.sourceDate} ({latestQuery.data.preview.timestampBasis}).
            Freshness threshold: {latestQuery.data.preview.freshnessThresholdAt}.
          </p>
          <p>Assigned owner: {latestQuery.data.policy.responsibleSubject}. This preview has not been sent.</p>
        </div>
      )}
      {pmoAdmin && (
        <details className="canonical-section">
          <summary>Reporting policy · PMO administration</summary>
          <p className="muted">
            Choose the complete required-fact set and a current RESPONSIBLE_OWNER. Leave scheduled scanning off unless the separately configured service identity and signing key are deployed.
          </p>
          <form onSubmit={savePolicy}>
            <div className="form-row">
              <TextField
                label="Freshness window (seconds)"
                type="number"
                min={1}
                max={315360000}
                required
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(event.target.value)}
              />
              <TextField
                label="Project time zone (IANA)"
                required
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                placeholder="e.g. Asia/Kolkata"
              />
            </div>
            <TextField
              label="Responsible owner subject"
              required
              maxLength={256}
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="Must match the canonical RESPONSIBLE_OWNER"
            />
            <label className="field">
              <span>Required facts (one per line: fact.type | label)</span>
              <textarea
                required
                rows={5}
                maxLength={20000}
                value={requiredFactsText}
                onChange={(event) => setRequiredFactsText(event.target.value)}
                placeholder={"project.status | Current status\nproject.forecast_end | Forecast finish"}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={scheduledScanEnabled}
                onChange={(event) => setScheduledScanEnabled(event.target.checked)}
              />
              Enable scheduled assessments for this project
            </label>
            <div className="actions">
              <Button type="submit" className="primary" disabled={busy || rows.length === 0}>
                Save policy revision
              </Button>
            </div>
            {message && <Message error={isError}>{message}</Message>}
          </form>
        </details>
      )}
      {!pmoAdmin && message && <Message error={isError}>{message}</Message>}
    </section>
  );
}
