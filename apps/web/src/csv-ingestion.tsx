import React, { useEffect, useMemo, useState } from "react";
import "./csv-ingestion.css";
import { Button, Message, SelectField, TextField } from "./components.js";

type Project = { id: string; code: string; name: string };
type Actor = { subject: string; customerId: string };
type MappingField = {
  column: string;
  factType: string;
  type: "text" | "date" | "number" | "boolean";
  required: boolean;
};
type Source = {
  sourceId: string;
  sourceType: string;
  origin: string;
  configRevision: number;
  mappingRevision: number;
  configuration: {
    binding: { customerId: string; sourceId: string };
    projects: { projectId: string; readers: string[] }[];
    mapping: {
      kind: "CSV";
      sheet: string;
      identityColumn: string;
      projectColumn: string;
      fields: MappingField[];
    } | { kind: "CONNECTOR"; factTypes: string[] };
  };
};
type Outcome = {
  ordinal: number;
  parentOrdinal: number | null;
  state: "ACCEPTED" | "INVALID" | "REVIEW_REQUIRED";
  operation: "CREATE" | "UPDATE" | "UNCHANGED" | "NONE";
  errorCodes: string[];
  projectId: string | null;
  identity: [string, string] | null;
  contentAvailable: boolean;
  proposals: { factType: string; value: unknown }[] | null;
};
type Receipt = {
  receipt: {
    id: string;
    kind: string;
    rowCount: number;
    configRevision: number;
    mappingRevision: number;
    parentPreviewReceiptId: string | null;
  };
  outcomes: Outcome[];
};
type Props = {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  projects: Project[];
  actor: Actor;
};
const CSV_ORIGIN = "https://csv-upload.invalid";
const emptyField = (): MappingField => ({
  column: "Forecast",
  factType: "project.forecast",
  type: "date",
  required: true,
});

export function CsvIngestion({ request, projects, actor }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [newSourceId, setNewSourceId] = useState(crypto.randomUUID());
  const [sheet, setSheet] = useState("Projects");
  const [identityColumn, setIdentityColumn] = useState("Issue ID");
  const [projectColumn, setProjectColumn] = useState("Project ID");
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [fields, setFields] = useState<MappingField[]>([emptyField()]);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Receipt | null>(null);
  const [reviewed, setReviewed] = useState<Receipt | null>(null);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [previewCommandKey, setPreviewCommandKey] = useState("");
  const [reviewCommandKey, setReviewCommandKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);

  const selectedSource = sources.find((source) => source.sourceId === selectedSourceId);
  const activeSourceId = selectedSource?.sourceId ?? (selectedSourceId ? "" : newSourceId);
  const eligibleRows = useMemo(
    () => (preview?.outcomes ?? []).filter((row) =>
      row.state === "ACCEPTED" && row.contentAvailable && row.proposals !== null,
    ),
    [preview],
  );

  async function loadSources() {
    const result = await request<Source[]>("/ingestion/sources");
    const csvSources = result.filter((source) => source.sourceType === "csv-upload" && source.configuration.mapping.kind === "CSV");
    setSources(csvSources);
    return csvSources;
  }

  useEffect(() => {
    let active = true;
    void request<Source[]>("/ingestion/sources")
      .then((result) => {
        if (!active) return;
        const csvSources = result.filter((source) => source.sourceType === "csv-upload" && source.configuration.mapping.kind === "CSV");
        setSources(csvSources);
        if (csvSources.length) setSelectedSourceId((current) => current || csvSources[0]!.sourceId);
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice((error as Error).message);
          setNoticeError(true);
        }
      });
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    if (!selectedSource) return;
    const mapping = selectedSource.configuration.mapping;
    if (mapping.kind !== "CSV") return;
    setSheet(mapping.sheet);
    setIdentityColumn(mapping.identityColumn);
    setProjectColumn(mapping.projectColumn);
    setSelectedProjects(selectedSource.configuration.projects.map((item) => item.projectId));
    setFields(mapping.fields.map((field) => ({ ...field })));
    setPreview(null);
    setReviewed(null);
    setSelectedRows([]);
    setFile(null);
  }, [selectedSource?.sourceId, selectedSource?.configRevision, selectedSource?.mappingRevision]);

  function newMapping() {
    setSelectedSourceId("");
    setNewSourceId(crypto.randomUUID());
    setSheet("Projects");
    setIdentityColumn("Issue ID");
    setProjectColumn("Project ID");
    setSelectedProjects([]);
    setFields([emptyField()]);
    setPreview(null);
    setReviewed(null);
    setSelectedRows([]);
    setFile(null);
    setNotice("");
  }

  function toggleProject(projectId: string) {
    setSelectedProjects((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId].sort());
  }

  async function saveMapping(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSourceId || !selectedProjects.length || !fields.length) return;
    setMappingBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const existingReaders = new Map(
        (selectedSource?.configuration.projects ?? []).map((item) => [item.projectId, item.readers]),
      );
      const result = await request<{ sourceId: string }>("/ingestion/sources/configuration", {
        method: "POST",
        body: JSON.stringify({
          binding: {
            customerId: actor.customerId,
            sourceId: activeSourceId,
            sourceType: "csv-upload",
            origin: CSV_ORIGIN,
          },
          projects: selectedProjects.map((projectId) => ({
            projectId,
            readers: [...new Set([...(existingReaders.get(projectId) ?? []), actor.subject])].sort(),
          })),
          mapping: { kind: "CSV", sheet, identityColumn, projectColumn, fields },
        }),
      });
      const refreshed = await loadSources();
      setSelectedSourceId(result.sourceId);
      setNotice("Mapping saved. The server will recheck project access and source-reader permissions for each upload and review.");
      setNoticeError(false);
      const saved = refreshed.find((source) => source.sourceId === result.sourceId);
      if (!saved) setNotice("Mapping saved. This account does not currently have access to every configured project, so the source is not shown here.");
    } catch (error) {
      setNotice((error as Error).message);
      setNoticeError(true);
    } finally {
      setMappingBusy(false);
    }
  }

  async function uploadAndPreview() {
    if (!file || !selectedSource) return;
    setBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const commandKey = previewCommandKey || crypto.randomUUID();
      setPreviewCommandKey(commandKey);
      const body = new FormData();
      body.set("file", file);
      body.set("commandKey", commandKey);
      body.set("configRevision", String(selectedSource.configRevision));
      body.set("mappingRevision", String(selectedSource.mappingRevision));
      const created = await request<{ receiptId: string }>(
        `/ingestion/sources/${selectedSource.sourceId}/csv-previews`,
        { method: "POST", body },
      );
      const receipt = await request<Receipt>(
        `/ingestion/sources/${selectedSource.sourceId}/receipts/${created.receiptId}`,
      );
      setPreview(receipt);
      setReviewed(null);
      setSelectedRows([]);
      setReviewCommandKey("");
      setNotice(`Preview saved with ${receipt.outcomes.length} rows. Select the eligible proposals you want to review.`);
      setNoticeError(false);
    } catch (error) {
      setNotice((error as Error).message);
      setNoticeError(true);
    } finally {
      setBusy(false);
    }
  }

  async function commitReviewedRows() {
    if (!selectedSource || !preview || !selectedRows.length) return;
    setBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const commandKey = reviewCommandKey || crypto.randomUUID();
      setReviewCommandKey(commandKey);
      const result = await request<{ receiptId: string; rowCount: number }>(
        `/ingestion/sources/${selectedSource.sourceId}/reviewed-imports`,
        {
          method: "POST",
          body: JSON.stringify({
            previewReceiptId: preview.receipt.id,
            rowOrdinals: [...selectedRows].sort((left, right) => left - right),
            commandKey,
          }),
        },
      );
      const receipt = await request<Receipt>(
        `/ingestion/sources/${selectedSource.sourceId}/receipts/${result.receiptId}`,
      );
      setReviewed(receipt);
      setNotice(`${result.rowCount} reviewed proposal${result.rowCount === 1 ? "" : "s"} saved. Canonical project facts were not changed.`);
      setNoticeError(false);
    } catch (error) {
      setNotice((error as Error).message);
      setNoticeError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="csv-ingestion">
      <section className="panel csv-ingestion-intro">
        <span className="eyebrow">SOURCE INGESTION</span>
        <h2>Review a CSV import</h2>
        <p className="muted">
          Configure the column mapping, preview the file, then save only the rows you approve as an immutable proposal receipt.
          This step does not publish or change canonical project facts.
        </p>
        <div className="csv-review-notice" role="note">
          Reviewed proposals remain separate from project facts. Each step checks your current project grants and the configured source-reader access.
        </div>
      </section>

      <div className="detail-grid csv-ingestion-grid">
        <section className="panel">
          <div className="csv-panel-heading">
            <div>
              <h2>Import mapping</h2>
              <p className="muted">Choose the project scope and map CSV columns to proposal fields.</p>
            </div>
            <Button className="secondary" onClick={newMapping}>New mapping</Button>
          </div>
          {sources.length > 0 && (
            <SelectField
              label="Configured source"
              value={selectedSourceId}
              onChange={(event) => setSelectedSourceId(event.target.value)}
            >
              <option value="">Create a new CSV source</option>
              {sources.map((source) => (
                <option value={source.sourceId} key={source.sourceId}>
                  CSV source · {source.sourceId.slice(0, 8)} · revision {source.configRevision}
                </option>
              ))}
            </SelectField>
          )}
          <form onSubmit={saveMapping} className="csv-mapping-form">
            <div className="form-row">
              <TextField label="Sheet label" required maxLength={256} value={sheet} onChange={(event) => setSheet(event.target.value)} />
              <TextField label="Identity column" required maxLength={256} value={identityColumn} onChange={(event) => setIdentityColumn(event.target.value)} />
            </div>
            <TextField label="Project ID column" required maxLength={256} value={projectColumn} onChange={(event) => setProjectColumn(event.target.value)} />
            <fieldset className="csv-project-scope">
              <legend>Project scope</legend>
              <p className="muted">Your account is added as a source reader for each selected project.</p>
              {projects.length ? projects.map((project) => (
                <label key={project.id} className="csv-project-option">
                  <input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={() => toggleProject(project.id)} />
                  <span><strong>{project.name}</strong><small>{project.code}</small></span>
                </label>
              )) : <p className="muted">No projects are available to configure for this account.</p>}
            </fieldset>
            <div className="csv-fields-heading">
              <div><h3>Field mappings</h3><p className="muted">Values stay proposals until a separate authorized process reviews them.</p></div>
              <Button className="secondary" onClick={() => setFields((current) => [...current, { ...emptyField(), column: "" }])}>Add field</Button>
            </div>
            {fields.map((field, index) => (
              <div className="csv-field-row" key={index}>
                <TextField label="CSV column" required maxLength={256} value={field.column} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, column: event.target.value } : item))} />
                <TextField label="Proposal field" required maxLength={96} pattern="[a-z][a-z0-9_.-]*" value={field.factType} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, factType: event.target.value } : item))} />
                <SelectField label="Value type" value={field.type} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, type: event.target.value as MappingField["type"] } : item))}>
                  <option value="text">Text</option><option value="date">Date</option><option value="number">Number</option><option value="boolean">Boolean</option>
                </SelectField>
                <label className="csv-required-option"><input type="checkbox" checked={field.required} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} /> Required</label>
                <Button className="text-button" disabled={fields.length === 1} onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            ))}
            <div className="actions">
              <Button type="submit" className="primary" disabled={mappingBusy || !selectedProjects.length || !fields.length}>
                {mappingBusy ? "Saving mapping…" : selectedSource ? "Save mapping" : "Create mapping"}
              </Button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h2>Upload and preview</h2>
          <p className="muted">CSV only · maximum 1 MiB · UTF-8 encoding. The original filename is not retained.</p>
          {selectedSource ? (
            <>
              <p className="csv-source-revision">Source revision {selectedSource.configRevision} · mapping revision {selectedSource.mappingRevision}</p>
              <label className="csv-file-field">
                <span>CSV file</span>
                <input type="file" accept=".csv,text/csv" onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreviewCommandKey("");
                  setReviewCommandKey("");
                  setPreview(null);
                  setReviewed(null);
                  setSelectedRows([]);
                }} />
              </label>
              <div className="actions">
                <Button className="primary" disabled={!file || busy} onClick={() => void uploadAndPreview()}>
                  {busy ? "Working…" : "Upload and preview"}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">Save a CSV mapping before uploading a file.</p>
          )}
          {notice && <Message error={noticeError}>{notice}</Message>}
        </section>
      </div>

      {preview && (
        <section className="panel csv-preview-panel">
          <div className="csv-panel-heading">
            <div>
              <h2>Preview {preview.receipt.id.slice(0, 8)}</h2>
              <p className="muted">Select only accepted rows with available proposal content. Invalid and ambiguous rows stay unselected.</p>
            </div>
            <Button className="secondary" disabled={!eligibleRows.length} onClick={() => setSelectedRows(eligibleRows.map((row) => row.ordinal))}>Select eligible rows</Button>
          </div>
          <div className="csv-table-wrap">
            <table className="csv-table">
              <thead><tr><th>Select</th><th>Row</th><th>Review state</th><th>Operation</th><th>Project</th><th>Proposal values</th></tr></thead>
              <tbody>
                {preview.outcomes.map((row) => {
                  const eligible = row.state === "ACCEPTED" && row.contentAvailable && row.proposals !== null;
                  return (
                    <tr key={row.ordinal}>
                      <td><input type="checkbox" aria-label={`Select row ${row.ordinal}`} checked={selectedRows.includes(row.ordinal)} disabled={!eligible || !!reviewed} onChange={(event) => setSelectedRows((current) => event.target.checked ? [...current, row.ordinal].sort((a, b) => a - b) : current.filter((ordinal) => ordinal !== row.ordinal))} /></td>
                      <td>{row.ordinal}</td>
                      <td><span className={`csv-state ${row.state.toLowerCase()}`}>{row.state.replaceAll("_", " ")}</span>{!row.contentAvailable && row.state === "ACCEPTED" && <small className="csv-error">Proposal content expired</small>}{row.errorCodes.map((code) => <small className="csv-error" key={code}>{code.replaceAll("_", " ")}</small>)}</td>
                      <td>{row.operation}</td>
                      <td>{row.projectId ? projects.find((project) => project.id === row.projectId)?.name ?? row.projectId.slice(0, 8) : "—"}</td>
                      <td>{row.proposals?.length ? <ul className="csv-proposals">{row.proposals.map((proposal, index) => <li key={`${proposal.factType}:${index}`}><strong>{proposal.factType}</strong><span>{JSON.stringify(proposal.value)}</span></li>)}</ul> : <span className="muted">No proposal content available</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="actions csv-review-actions">
            <Button className="primary" disabled={!selectedRows.length || busy || !!reviewed} onClick={() => void commitReviewedRows()}>
              {busy ? "Saving receipt…" : `Save ${selectedRows.length} reviewed proposal${selectedRows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
          {reviewed && (
            <div className="csv-review-receipt" role="status">
              <strong>Reviewed import receipt saved</strong>
              <span>{reviewed.receipt.id}</span>
              <small>Parent preview: {reviewed.receipt.parentPreviewReceiptId}</small>
              <small>Canonical project facts were not changed.</small>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
