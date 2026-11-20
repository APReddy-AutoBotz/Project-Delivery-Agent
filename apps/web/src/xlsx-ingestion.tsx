import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, SelectField, TextField } from "./components.js";
import { uuid } from "./evidence-state.js";
import type { RequestFn } from "./request-types.js";
import {
  encodeSheet, readCatalogue, readPreviewPage, readPreviewResult, readReviewDetails, readReviewResult,
  type Catalogue, type PreviewPage, type PreviewResult, type ReviewCommand, type ReviewDetails,
  type ReviewResult, type XlsxSource,
} from "./xlsx-ingestion-contract.js";

const sourcesPath = "/ingestion/xlsx/sources";
const workbookLimit = 1_048_576;
const previewResponseLimit = 8 * 1024 * 1024;

type Scope = { request: RequestFn; isCurrent: () => boolean };
type Operation = { current: () => boolean; send: RequestFn };

function useOperation(scope: Scope) {
  const owner = useRef<{ request: RequestFn; operation: AbortController | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const instance = { request: scope.request, operation: null };
    owner.current = instance;
    setBusy(false);
    return () => {
      owner.current?.operation?.abort();
      owner.current = null;
    };
  }, [scope.request]);

  async function run(work: (operation: Operation) => Promise<void>) {
    const instance = owner.current;
    if (!instance || instance.request !== scope.request || instance.operation || !scope.isCurrent()) return;
    const operation = new AbortController();
    instance.operation = operation;
    const current = () => owner.current === instance && instance.operation === operation && scope.isCurrent();
    const send: RequestFn = (path, init, cap, unavailable, managed, _, status) =>
      scope.request(path, { ...init, signal: operation.signal }, cap, unavailable, managed, current, status);
    setBusy(true);
    try {
      await work({ current, send });
    } finally {
      operation.abort();
      if (owner.current === instance && instance.operation === operation) {
        instance.operation = null;
        setBusy(false);
      }
    }
  }

  return { busy, run };
}

export function XlsxIngestion(scope: Scope) {
  const operation = useOperation(scope);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<XlsxSource | null>(null);
  const currentSource = useRef<XlsxSource | null>(null);

  function choose(source: XlsxSource | null) {
    currentSource.current = source;
    setSelected(source);
  }

  function load(after: string | null) {
    return operation.run(async ({ current, send }) => {
      choose(null);
      setCursor(after);
      setCatalogue(null);
      setUnavailable(false);
      const path = after ? sourcesPath + "?afterSourceId=" + after : sourcesPath;
      try {
        const result = readCatalogue(await send(path, {}, 24_576, undefined, undefined, undefined, 200), after);
        if (current()) setCatalogue(result);
      } catch {
        if (current()) setUnavailable(true);
      }
    });
  }

  useEffect(() => { void load(null); }, [scope.request]);

  return <div className="grid gap-5">
    <section className="panel" aria-labelledby="xlsx-sources-title">
      <h2 id="xlsx-sources-title">Excel sources</h2>
      {operation.busy && <p role="status">Loading authorized Excel sources…</p>}
      {unavailable && <p role="alert">Excel sources are unavailable. <Button className="secondary" onClick={() => void load(null)}>Retry Excel sources</Button></p>}
      {catalogue && <>
        {catalogue.sources.length ? <SelectField label="Excel source" value={selected?.sourceId ?? ""}
          onChange={(event) => {
            if (scope.isCurrent()) choose(catalogue.sources.find((source) => source.sourceId === event.target.value) ?? null);
          }}>
          <option value="">Choose an authorized source</option>
          {catalogue.sources.map((source) => <option key={source.sourceId} value={source.sourceId}>
            {source.sheet} · {source.sourceId}
          </option>)}
        </SelectField> : <p>No authorized Excel sources on this page.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {cursor && <Button className="secondary" onClick={() => void load(null)}>First Excel sources</Button>}
          {catalogue.nextSourceId && <Button className="secondary" onClick={() => void load(catalogue.nextSourceId)}>More Excel sources</Button>}
        </div>
      </>}
    </section>
    {selected && <XlsxSourceImport key={selected.sourceId} source={selected} request={scope.request}
      isCurrent={() => scope.isCurrent() && currentSource.current === selected} />}
  </div>;
}

type PreviewCommand = { key: string; file: File };
type Pending = { kind: "preview"; command: PreviewCommand } | { kind: "review"; command: ReviewCommand };
type Receipt = { page: PreviewPage; details: ReviewDetails; after: number };
type ReceiptTarget = { id: string; preview?: PreviewResult; reviewed?: ReviewResult };

function isUncertain(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return typeof status !== "number" || status >= 500 || status === 429;
}

function XlsxSourceImport({ source, ...scope }: Scope & { source: XlsxSource }) {
  const operation = useOperation(scope);
  const path = sourcesPath + "/" + source.sourceId;
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [receiptId, setReceiptId] = useState("");
  const [target, setTarget] = useState<ReceiptTarget | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState("");

  function clearFile() {
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function showReceipt({ current, send }: Operation, lookup: ReceiptTarget, after: number, previous?: PreviewPage) {
    const previewPath = path + "/previews/" + lookup.id;
    try {
      const [rawPage, rawDetails] = await Promise.all([
        send(previewPath + "?afterOrdinal=" + after, {}, previewResponseLimit, undefined, undefined, undefined, 200),
        send(previewPath + "/review-details", {}, 65_536, undefined, undefined, undefined, 200),
      ]);
      if (!current()) return;
      const page = readPreviewPage(rawPage, source.sourceId, lookup.id, after);
      const details = readReviewDetails(rawDetails, page);
      if ((lookup.preview && page.rowCount !== lookup.preview.rowCount) ||
        (lookup.reviewed && (details.reviewedImport?.receiptId !== lookup.reviewed.receiptId ||
          details.reviewedImport.rowCount !== lookup.reviewed.rowCount)) ||
        (previous && (page.previewContextSha256 !== previous.previewContextSha256 ||
          page.rowCount !== previous.rowCount || page.configRevision !== previous.configRevision ||
          page.mappingRevision !== previous.mappingRevision)) ||
        (page.selectionState === "REVIEWED" && !details.reviewedImport))
        throw new Error("Unexpected Excel receipt details.");
      setReceipt({ page, details, after });
      setSelected((rows) => canSelect(page, details)
        ? rows.filter((ordinal) => !page.outcomes.some((row) => row.ordinal === ordinal && !row.selectable))
        : []);
    } catch {
      if (current()) {
        setReceipt(null);
        setSelected([]);
        setNotice("The Excel receipt is unavailable. Reopen the preview to check its current access and status.");
      }
    }
  }

  function canSelect(page: PreviewPage, details: ReviewDetails) {
    return page.selectionState === "OPEN" && !details.reviewedImport &&
      page.configRevision === source.configRevision && page.mappingRevision === source.mappingRevision;
  }

  function openReceipt(id: string) {
    if (!uuid.test(id) || pending) return;
    void operation.run(async (request) => {
      const lookup = target?.id === id ? target : { id };
      clearFile();
      setReceipt(null);
      setSelected([]);
      setNotice("");
      setTarget(lookup);
      await showReceipt(request, lookup, 0);
    });
  }

  function moreRows(after: number) {
    if (!receipt || !target || pending) return;
    const previous = receipt.page;
    void operation.run(async (request) => {
      setReceipt(null);
      setNotice("");
      await showReceipt(request, target, after, previous);
    });
  }

  function upload(command: PreviewCommand) {
    void operation.run(async (request) => {
      const { current, send } = request;
      setNotice("");
      setTarget(null);
      setReceipt(null);
      setReceiptId("");
      setSelected([]);
      const body = new FormData();
      body.append("commandKey", command.key);
      body.append("configRevision", String(source.configRevision));
      body.append("mappingRevision", String(source.mappingRevision));
      body.append("sheet", encodeSheet(source.sheet));
      body.append("file", command.file, "workbook.xlsx");
      let confirmed: PreviewResult;
      try {
        confirmed = readPreviewResult(await send(path + "/previews", { method: "POST", body },
          4096, undefined, undefined, undefined, 201));
      } catch (error) {
        if (current()) {
          const uncertain = isUncertain(error);
          setPending(uncertain ? { kind: "preview", command } : null);
          if (!uncertain) clearFile();
          setNotice(uncertain ? "The upload outcome could not be confirmed. Retry the same workbook."
            : "The workbook could not be previewed. Check the file and the current source configuration.");
        }
        return;
      }
      if (!current()) return;
      clearFile();
      setPending(null);
      const lookup = { id: confirmed.receiptId, preview: confirmed };
      setReceiptId(lookup.id);
      setTarget(lookup);
      await showReceipt(request, lookup, 0);
    });
  }

  function save(command: ReviewCommand) {
    void operation.run(async (request) => {
      const { current, send } = request;
      setNotice("");
      // Hide content immediately while the server rechecks permission and retention.
      setReceipt(null);
      setSelected([]);
      let confirmed: ReviewResult;
      try {
        confirmed = readReviewResult(await send(path + "/reviewed-imports",
          { method: "POST", body: JSON.stringify(command) }, 4096, undefined, undefined, undefined, 201), command);
      } catch (error) {
        if (current()) {
          const uncertain = isUncertain(error);
          setPending(uncertain ? { kind: "review", command } : null);
          setNotice(uncertain ? "The save outcome could not be confirmed. Retry the original selection."
            : "The proposals could not be saved. Reopen the preview to check its current access and status.");
        }
        return;
      }
      if (!current()) return;
      setPending(null);
      const lookup = { id: command.previewReceiptId, reviewed: confirmed };
      setTarget(lookup);
      await showReceipt(request, lookup, 0);
    });
  }

  const { busy } = operation;
  const selectable = receipt && canSelect(receipt.page, receipt.details);
  return <div className="grid gap-5">
    <section className="panel" aria-labelledby="xlsx-upload-title">
      <h2 id="xlsx-upload-title">Preview an Excel workbook</h2>
      <p>Configured worksheet <strong>{source.sheet}</strong> · Mapping revision {source.mappingRevision}</p>
      <label className="csv-file-field">
        <span>Excel workbook</span>
        <input ref={fileInput} type="file" accept=".xlsx" disabled={busy || pending !== null}
          onChange={(event) => {
            if (!scope.isCurrent()) return;
            const next = event.target.files?.[0];
            if (!next || next.size === 0 || next.size > workbookLimit) {
              clearFile();
              setNotice(next ? "Choose a non-empty workbook up to 1 MiB." : "");
              return;
            }
            setFile(next);
            setNotice("");
          }} />
      </label>
      {pending?.kind === "preview" ? <Button className="secondary" disabled={busy}
        onClick={() => upload(pending.command)}>Retry same workbook</Button>
        : <Button className="primary" disabled={busy || !file || pending !== null}
          onClick={() => { if (file) upload({ key: crypto.randomUUID(), file }); }}>Upload and preview workbook</Button>}
      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        openReceipt(receiptId.trim().toLowerCase());
      }}>
        <TextField label="Excel preview receipt ID" value={receiptId} maxLength={36} disabled={busy || pending !== null}
          onChange={(event) => setReceiptId(event.target.value)} />
        <Button type="submit" className="secondary" disabled={busy || pending !== null || !uuid.test(receiptId.trim().toLowerCase())}>Open Excel preview</Button>
      </form>
      {pending?.kind === "review" && <Button className="secondary mt-3" disabled={busy}
        onClick={() => save(pending.command)}>Retry original Excel selection</Button>}
      {busy && <p role="status">Checking Excel import…</p>}
      {notice && <p role="alert">{notice}</p>}
    </section>
    {receipt && <section className="panel csv-preview-panel" aria-labelledby="xlsx-preview-title">
      <h2 id="xlsx-preview-title">Excel preview · {receipt.page.rowCount} rows</h2>
      <p>Preview receipt <code>{receipt.page.previewReceiptId}</code></p>
      <h3>Sealed column mapping</h3>
      <p>Worksheet <strong>{receipt.details.mapping.sheet}</strong> · Identity column <strong>{receipt.details.mapping.identityColumn}</strong> · Project column <strong>{receipt.details.mapping.projectColumn}</strong></p>
      <ul>{receipt.details.mapping.fields.map((field) => <li key={field.factType}>
        {field.column} → {field.factType} ({field.type}{field.required ? ", required" : ""})
      </li>)}</ul>
      {receipt.details.reviewedImport && <div className="csv-review-receipt">
        <strong>Reviewed Excel import saved · {receipt.details.reviewedImport.rowCount} selected rows</strong>
        <span>{receipt.details.reviewedImport.receiptId}</span>
        <small>{new Date(receipt.details.reviewedImport.createdAt).toISOString()}</small>
        <p>Saved proposals follow the existing approval process for canonical project facts.</p>
      </div>}
      {!selectable && !receipt.details.reviewedImport && <p>This preview is closed for row selection.</p>}
      {receipt.page.outcomes.length > 0 && <div className="csv-table-wrap"><table className="csv-table">
        <thead><tr><th scope="col">Row</th><th scope="col">Validation</th><th scope="col">Planned change</th><th scope="col">Proposals</th></tr></thead>
        <tbody>{receipt.page.outcomes.map((row) => <tr key={row.ordinal}>
          <td><label><input type="checkbox" aria-label={`Select Excel row ${row.ordinal}`} checked={selected.includes(row.ordinal)}
            disabled={busy || !selectable || !row.selectable} onChange={(event) => {
              if (!scope.isCurrent() || !selectable || !row.selectable) return;
              const checked = event.target.checked;
              setSelected((rows) => checked ? [...rows, row.ordinal] : rows.filter((ordinal) => ordinal !== row.ordinal));
            }} /> {row.ordinal}</label></td>
          <td>{row.state.replaceAll("_", " ")}{row.errorCodes.map((code) => <small className="csv-error" key={code}>{code.replaceAll("_", " ")}</small>)}</td>
          <td>{row.operation}{row.projectId && <div className="break-all text-xs">{row.projectId}</div>}</td>
          <td>{!row.contentAvailable ? "Content unavailable" : row.proposals?.length
            ? <ul className="csv-proposals">{row.proposals.map(({ factType, value }) =>
              <li key={factType}>{factType} <span>{value.type === "empty" ? "Empty" : String(value.value)}</span></li>)}</ul>
            : "No proposals"}</td>
        </tr>)}</tbody>
      </table></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {receipt.after > 0 && <Button className="secondary" onClick={() => moreRows(0)}>First Excel rows</Button>}
        {receipt.page.nextOrdinal !== null && <Button className="secondary" onClick={() => {
          if (receipt.page.nextOrdinal !== null) moreRows(receipt.page.nextOrdinal);
        }}>More Excel rows</Button>}
        {selectable && <Button className="primary" disabled={busy || selected.length === 0} onClick={() => save({
          commandKey: crypto.randomUUID(), previewReceiptId: receipt.page.previewReceiptId,
          previewContextSha256: receipt.page.previewContextSha256, rowOrdinals: [...selected].sort((a, b) => a - b),
        })}>Save reviewed Excel proposals ({selected.length})</Button>}
      </div>
    </section>}
  </div>;
}
