import React, { useEffect, useMemo, useState } from "react";
import "./csv-ingestion.css";
import { Button, Message, SelectField, TextField } from "./components.js";
import { AccessGrantWriteRegistry } from "./access-grant-write-registry.js";
import { CanonicalCreationWriteRegistry, canonicalCommandFingerprint } from "./canonical-creation-write-registry.js";
import type { RequestFn } from "./request-types.js";
import { ManagedReadRegistry } from "./managed-read-registry.js";
import { managedRead } from "./managed-read.js";

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
const reviewable = (row: Outcome) => row.state === "ACCEPTED" && ["CREATE", "UPDATE", "UNCHANGED"].includes(row.operation) &&
  row.errorCodes.length === 0 && row.contentAvailable && row.proposals !== null;
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
type SavedReceipt = { owner: string; lease: symbol; subject: string; sourceId: string; receiptId: string; kind: "CSV_PREVIEW" | "CSV_REVIEWED_IMPORT"; parent: string | null; rows: number[]; rowCount: number; configRevision: number; mappingRevision: number };
type ReceiptTicket = { denied: boolean; active: number; pinned: boolean };
type ImportCommand = { kind: "preview" | "review"; subject: string; key: string; fingerprint: string; sourceId: string;
  configRevision: number; mappingRevision: number; parent?: SavedReceipt; rows?: number[] };
type Props = {
  request: RequestFn;
  projects: Project[];
  actor: Actor;
  isCurrentScope: () => boolean;
};
const CSV_ORIGIN = "https://csv-upload.invalid";
const configurationWrites = new AccessGrantWriteRegistry();
// A page-lifetime guard, not a durable or cross-tab lock. Only the original
// subject/key/fingerprint can retry an unresolved command.
const importWrites = new CanonicalCreationWriteRegistry();
const importCommands = new Map<string, ImportCommand>();
const confirmedReceipts = new Map<string, SavedReceipt>();
const sourceReads = new ManagedReadRegistry(8);
const receiptReads = new ManagedReadRegistry(8);
const configurationFences = new Map<string, { lease: symbol; configRevision: number; mappingRevision: number; fingerprint: string; instance: symbol; epoch: number }>();
const sourceOwner = (customer: string, source: string) => JSON.stringify([customer.toLowerCase(), source.toLowerCase()]);
const csvUuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const wireText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value);
const unique = (items: string[]) => new Set(items).size === items.length;
const factType = (value: unknown): value is string => wireText(value, 96) && /^[a-z][a-z0-9_.-]*$/.test(value);
const validOrigin = (value: unknown): value is string => {
  if (!wireText(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && url.origin === value; } catch { return false; }
};
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
async function previewSnapshot(subject: string, source: Source, file: File, current: () => boolean): Promise<{ fingerprint: string; body: Blob }> {
  if (file.size < 1 || file.size > 1024 * 1024 || !file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a CSV file of at most 1 MiB.");
  const header = JSON.stringify(["csv-preview-v1", subject, source.sourceId.toLowerCase(), source.configRevision, source.mappingRevision, file.size]);
  const bytes = await file.arrayBuffer();
  if (!current() || bytes.byteLength !== file.size) throw new Error("Preview preparation changed.");
  const encoded = await new Blob([header, "\0", bytes]).arrayBuffer();
  if (!current()) throw new Error("Preview preparation changed.");
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  if (!current()) throw new Error("Preview preparation changed.");
  return { fingerprint: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""),
    body: new Blob([bytes], { type: "text/csv" }) };
}
function reviewFingerprint(subject: string, source: Source, parent: string, rows: number[]) {
  return canonicalCommandFingerprint(subject, JSON.stringify(["csv-review-v1", source.sourceId.toLowerCase(), source.configRevision,
    source.mappingRevision, parent.toLowerCase(), rows]));
}
function mappingFingerprint(projects: { projectId: string; readers: string[] }[], mapping: { sheet: string; identityColumn: string; projectColumn: string; fields: MappingField[] }) {
  return JSON.stringify([projects.map((project) => [project.projectId.toLowerCase(), [...project.readers].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    mapping.sheet, mapping.identityColumn, mapping.projectColumn, mapping.fields.map((field) => [field.column, field.factType, field.type, field.required])]);
}
export function decodeSources(value: unknown, customerId: string): Source[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Sources are unavailable.");
  const ids = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (!record(entry) || !keys(entry, ["sourceId", "sourceType", "origin", "configuration", "configRevision", "mappingRevision", "healthState", "healthCode", "healthCheckedAt"]) ||
      typeof entry.sourceId !== "string" || !csvUuid.test(entry.sourceId) || !wireText(entry.sourceType, 96) || !validOrigin(entry.origin) ||
      !revision(entry.configRevision) || !revision(entry.mappingRevision) || entry.mappingRevision > entry.configRevision ||
      typeof entry.healthState !== "string" || !["UNKNOWN", "HEALTHY", "DEGRADED", "FAILED"].includes(entry.healthState) ||
      typeof entry.healthCode !== "string" || !["NONE", "INVALID_CREDENTIALS", "EXPIRED_CREDENTIALS", "PERMISSION_DENIED", "RATE_LIMITED", "TEMPORARILY_UNAVAILABLE", "INVALID_RESPONSE", "NOT_FOUND", "UNKNOWN_OUTCOME", "INTEGRITY_CONFLICT", "CURSOR_CONFLICT"].includes(entry.healthCode) ||
      !(entry.healthCheckedAt === null || (typeof entry.healthCheckedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.healthCheckedAt) && Number.isFinite(Date.parse(entry.healthCheckedAt)) && new Date(entry.healthCheckedAt).toISOString() === entry.healthCheckedAt)) ||
      !record(entry.configuration) || !keys(entry.configuration, ["binding", "projects", "mapping"])) throw new Error("Sources are unavailable.");
    const source = entry as unknown as Source, config = entry.configuration, binding = config.binding, id = source.sourceId.toLowerCase();
    if (!record(binding) || !keys(binding, ["customerId", "sourceId", "sourceType", "origin"]) || typeof binding.customerId !== "string" || !csvUuid.test(binding.customerId) ||
      typeof binding.sourceId !== "string" || !csvUuid.test(binding.sourceId) || ids.has(id) || binding.customerId.toLowerCase() !== customerId.toLowerCase() || binding.sourceId.toLowerCase() !== id ||
      binding.sourceType !== source.sourceType || binding.origin !== source.origin || !Array.isArray(config.projects) || config.projects.length < 1 || config.projects.length > 100 ||
      !record(config.mapping)) throw new Error("Sources are unavailable.");
    const projectIds: string[] = [];
    for (const project of config.projects) {
      if (!record(project) || !keys(project, ["projectId", "readers"]) || typeof project.projectId !== "string" || !csvUuid.test(project.projectId) ||
        !Array.isArray(project.readers) || project.readers.length > 100 || !project.readers.every((reader: unknown) => wireText(reader, 256)) || !unique(project.readers)) throw new Error("Sources are unavailable.");
      projectIds.push(project.projectId.toLowerCase());
    }
    if (!unique(projectIds)) throw new Error("Sources are unavailable.");
    const mapping = config.mapping;
    if (mapping.kind === "CSV") {
      if (!keys(mapping, ["kind", "sheet", "identityColumn", "projectColumn", "fields"]) || !wireText(mapping.sheet, 256) ||
        !wireText(mapping.identityColumn, 256) || !wireText(mapping.projectColumn, 256) || mapping.identityColumn === mapping.projectColumn ||
        !Array.isArray(mapping.fields) || mapping.fields.length < 1 || mapping.fields.length > 32) throw new Error("Sources are unavailable.");
      const columns: string[] = [], facts: string[] = [];
      for (const field of mapping.fields) {
        if (!record(field) || !keys(field, ["column", "factType", "type", "required"]) || !wireText(field.column, 256) || !factType(field.factType) ||
          typeof field.type !== "string" || !["text", "date", "number", "boolean"].includes(field.type) || typeof field.required !== "boolean") throw new Error("Sources are unavailable.");
        columns.push(field.column); facts.push(field.factType);
      }
      if (!unique(columns) || !unique(facts)) throw new Error("Sources are unavailable.");
    } else if (mapping.kind === "CONNECTOR") {
      const expected = Object.hasOwn(mapping, "adapterConfiguration") ? ["kind", "factTypes", "adapterConfiguration"] : ["kind", "factTypes"];
      if (!keys(mapping, expected) || !Array.isArray(mapping.factTypes) || mapping.factTypes.length > 32 || !mapping.factTypes.every(factType) ||
        !unique(mapping.factTypes) || (Object.hasOwn(mapping, "adapterConfiguration") && !wireText(mapping.adapterConfiguration, 30000))) throw new Error("Sources are unavailable.");
    } else throw new Error("Sources are unavailable.");
    ids.add(id);
    return source.sourceType === "csv-upload" && source.configuration.mapping.kind === "CSV" ? [source as Source] : [];
  });
}
function decodeReceipt(value: unknown, expected: SavedReceipt, allowedProjects: string[]): Receipt {
  if (!record(value) || !keys(value, ["receipt", "outcomes"]) || !record(value.receipt) || !Array.isArray(value.outcomes) || value.outcomes.length > 1000)
    throw new Error("Receipt is unavailable.");
  const receipt = value.receipt;
  if (!keys(receipt, ["id", "sourceId", "actor", "kind", "eventId", "configRevision", "mappingRevision", "cursorRevisionBefore", "cursorRevisionAfter", "generationBefore", "generationAfter", "rowCount", "createdAt", "parentPreviewReceiptId"]) ||
    receipt.id !== expected.receiptId || receipt.sourceId !== expected.sourceId || receipt.actor !== expected.subject || receipt.kind !== expected.kind ||
    receipt.parentPreviewReceiptId !== expected.parent || receipt.configRevision !== expected.configRevision || receipt.mappingRevision !== expected.mappingRevision ||
    receipt.rowCount !== expected.rowCount || !(receipt.eventId === null || wireText(receipt.eventId, 256)) ||
    ![receipt.cursorRevisionBefore, receipt.cursorRevisionAfter].every((v) => v === null || (Number.isSafeInteger(v) && Number(v) >= 0)) ||
    ![receipt.generationBefore, receipt.generationAfter].every((v) => v === null || revision(v)) ||
    typeof receipt.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.createdAt) ||
    !Number.isFinite(Date.parse(receipt.createdAt)) || new Date(receipt.createdAt).toISOString() !== receipt.createdAt) throw new Error("Receipt is unavailable.");
  if (value.outcomes.length !== expected.rowCount) throw new Error("Receipt is unavailable.");
  const allowed = new Set(allowedProjects.map((id) => id.toLowerCase())), seen = new Set<number>();
  for (const [index, row] of value.outcomes.entries()) {
    if (!record(row) || !keys(row, ["ordinal", "parentOrdinal", "state", "operation", "errorCodes", "projectId", "identity", "contentAvailable", "proposals"]) ||
      !Number.isInteger(row.ordinal) || Number(row.ordinal) < 1 || Number(row.ordinal) > 1000 || seen.has(Number(row.ordinal)) ||
      !(row.parentOrdinal === null || (Number.isInteger(row.parentOrdinal) && Number(row.parentOrdinal) >= 1 && Number(row.parentOrdinal) <= 1000)) ||
      typeof row.state !== "string" || !["ACCEPTED", "INVALID", "REVIEW_REQUIRED"].includes(row.state) ||
      typeof row.operation !== "string" || !["CREATE", "UPDATE", "UNCHANGED", "NONE"].includes(row.operation) ||
      !Array.isArray(row.errorCodes) || row.errorCodes.length > 16 || !row.errorCodes.every((code: unknown) => typeof code === "string" &&
        ["INVALID_INPUT", "INVALID_KEY", "DUPLICATE_KEY", "INVALID_PROJECT", "PROJECT_CHANGED", "INVALID_FIELDS", "ROW_IDENTITY_REVIEW", "REQUIRED_VALUE", "INVALID_FORMULA", "INVALID_NUMBER", "INVALID_VALUE"].includes(code)) ||
      !(row.projectId === null || (typeof row.projectId === "string" && csvUuid.test(row.projectId) && allowed.has(row.projectId.toLowerCase()))) ||
      !(row.identity === null || (Array.isArray(row.identity) && row.identity.length === 2 && wireText(row.identity[0], 267) && wireText(row.identity[1], 256))) ||
      typeof row.contentAvailable !== "boolean" || !(row.proposals === null || (Array.isArray(row.proposals) && row.proposals.length <= 32))) throw new Error("Receipt is unavailable.");
    if (row.contentAvailable !== (row.proposals !== null) || (row.contentAvailable && (row.projectId === null || row.identity === null)))
      throw new Error("Receipt is unavailable.");
    if (row.ordinal !== index + 1 || (expected.kind === "CSV_PREVIEW" && row.parentOrdinal !== null) ||
      (expected.kind === "CSV_REVIEWED_IMPORT" && (row.parentOrdinal !== expected.rows[index] || row.state !== "ACCEPTED" ||
        !["CREATE", "UPDATE", "UNCHANGED"].includes(String(row.operation)) || row.errorCodes.length !== 0 || row.projectId === null)))
      throw new Error("Receipt is unavailable.");
    seen.add(Number(row.ordinal));
    if (Array.isArray(row.proposals)) for (const proposal of row.proposals) {
      if (!record(proposal) || !keys(proposal, ["factType", "value"]) || !factType(proposal.factType) || !record(proposal.value) ||
        !keys(proposal.value, ["type", "value"]) || typeof proposal.value.type !== "string") throw new Error("Receipt is unavailable.");
      const fact = proposal.value;
      if (!((fact.type === "empty" && fact.value === null) || (fact.type === "boolean" && typeof fact.value === "boolean") ||
        (fact.type === "number" && typeof fact.value === "number" && Number.isFinite(fact.value)) ||
        (fact.type === "text" && typeof fact.value === "string" && fact.value.length <= 4096 && !/[\0\p{Surrogate}]/u.test(fact.value)) ||
        (fact.type === "date" && typeof fact.value === "string" && /^\d{4}-\d\d-\d\d$/.test(fact.value) && !fact.value.startsWith("0000-") &&
          Number.isFinite(Date.parse(`${fact.value}T00:00:00.000Z`)) && new Date(`${fact.value}T00:00:00.000Z`).toISOString().slice(0, 10) === fact.value))) throw new Error("Receipt is unavailable.");
    }
  }
  return value as unknown as Receipt;
}
const emptyField = (): MappingField => ({
  column: "Forecast",
  factType: "project.forecast",
  type: "date",
  required: true,
});

export function CsvIngestion({ request, projects, actor, isCurrentScope }: Props) {
  const operation = React.useRef(false), draftEpoch = React.useRef(0), sourceIssuance = React.useRef(0);
  const operationGeneration = React.useRef(0), [renderedOperationGeneration, setRenderedOperationGeneration] = useState(0);
  const beginOperation = () => { operation.current = true; operationGeneration.current++; setRenderedOperationGeneration(operationGeneration.current); };
  const instance = React.useRef(Symbol("csv-owner"));
  const [renderedDraftEpoch, setRenderedDraftEpoch] = useState(0);
  const editDraft = (mapping: boolean) => { draftEpoch.current++; setRenderedDraftEpoch(draftEpoch.current); if (mapping) mappingDirty.current = true; };
  const draftCurrent = () => draftEpoch.current === renderedDraftEpoch;
  const sourceProof = React.useRef<{ request: RequestFn; issuance: number; value: Source[] } | null>(null);
  const initialSelectionPending = React.useRef(true);
  const sourceErrorProof = React.useRef<{ request: RequestFn; issuance: number } | null>(null);
  const [sourceResult, setSourceResult] = useState<{ request: RequestFn; issuance: number; value: Source[] } | null>(null);
  const [, refreshSourceProof] = React.useReducer((value: number) => value + 1, 0);
  const sourceCurrent = () => isCurrentScope() && sourceResult !== null && sourceProof.current === sourceResult &&
    sourceResult.request === request && sourceResult.issuance === sourceIssuance.current;
  React.useSyncExternalStore(configurationWrites.subscribe, configurationWrites.snapshot, configurationWrites.snapshot);
  React.useSyncExternalStore(importWrites.subscribe, importWrites.snapshot, importWrites.snapshot);
  const sources = sourceResult?.value ?? [];
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [, refreshSavedReceipt] = React.useReducer((value: number) => value + 1, 0);
  const [lastReceipt, setLastReceipt] = useState<SavedReceipt | null>(null);
  const receiptProofRef = React.useRef<{ source: NonNullable<typeof sourceResult>; receipt: SavedReceipt } | null>(null);
  const [receiptProof, setReceiptProof] = useState<{ source: NonNullable<typeof sourceResult>; receipt: SavedReceipt } | null>(null);
  const [receiptError, setReceiptError] = useState(false), [receiptAttempt, setReceiptAttempt] = useState(0);
  const receiptAttemptRef = React.useRef(0), receiptIssuance = React.useRef(0);
  const receiptFences = React.useRef(new Map<string, ReceiptTicket>()), receiptReservations = React.useRef(0);
  const receiptKey = (saved: SavedReceipt) => JSON.stringify([saved.owner, saved.receiptId.toLowerCase()]);
  const makeReceiptRoom = (protectedTicket: ReceiptTicket | null = null) => {
    for (const [key, ticket] of receiptFences.current) {
      if (receiptFences.current.size + receiptReservations.current < 64) break;
      if (ticket !== protectedTicket && !ticket.denied && !ticket.pinned && ticket.active === 0) receiptFences.current.delete(key);
    }
    return receiptFences.current.size + receiptReservations.current < 64;
  };
  const receiptFenceFor = (saved: SavedReceipt) => {
    const key = receiptKey(saved), existing = receiptFences.current.get(key);
    if (existing) return existing;
    if (!makeReceiptRoom()) return null;
    const ticket: ReceiptTicket = { denied: false, active: 0, pinned: confirmedReceipts.get(saved.owner) === saved };
    receiptFences.current.set(key, ticket); return ticket;
  };
  const receiptFenceCurrent = (saved: SavedReceipt, ticket: ReceiptTicket | null) =>
    Boolean(ticket && receiptFences.current.get(receiptKey(saved)) === ticket && !ticket.denied);
  const reserveReceipt = (protectedTicket: ReceiptTicket | null = null) => {
    if (!makeReceiptRoom(protectedTicket)) return false; receiptReservations.current++; return true;
  };
  const assignReceipt = (saved: SavedReceipt) => {
    const key = receiptKey(saved);
    const existing = receiptFences.current.get(key);
    if (existing) existing.pinned = true;
    else receiptFences.current.set(key, { denied: false, active: 0, pinned: true });
    receiptReservations.current--;
  };
  const renderedReceiptIssuance = receiptIssuance.current;
  const [sourceError, setSourceError] = useState<{ request: RequestFn; issuance: number } | null>(null);
  const hydrated = React.useRef<{ sourceId: string; configRevision: number; mappingRevision: number } | null>(null);
  const [renderedHydration, setRenderedHydration] = useState<{ sourceId: string; configRevision: number; mappingRevision: number } | null>(null);
  const mappingDirty = React.useRef(false), rehydrating = React.useRef(false);
  const [mappingReload, setMappingReload] = useState(0);

  const selectedSource = sources.find((source) => source.sourceId === selectedSourceId);
  const activeSourceId = selectedSource?.sourceId ?? (selectedSourceId ? "" : newSourceId);
  const configurationOwner = sourceOwner(actor.customerId, activeSourceId);
  const configurationFence = configurationFences.get(configurationOwner);
  const ownerReceipt = confirmedReceipts.get(configurationOwner);
  const savedReceipt = ownerReceipt?.subject === actor.subject ? ownerReceipt : null;
  const configurationState = configurationWrites.state(configurationOwner);
  const importCommand = importCommands.get(configurationOwner);
  const retryCommand = importCommand?.subject === actor.subject ? importCommand : undefined;
  const renderedImportVersion = importWrites.snapshot();
  const importState = importWrites.state(configurationOwner, retryCommand ? { key: retryCommand.key, fingerprint: retryCommand.fingerprint } : null);
  const matchingRetrySource = Boolean(retryCommand && selectedSource && retryCommand.sourceId === selectedSource.sourceId &&
    retryCommand.configRevision === selectedSource.configRevision && retryCommand.mappingRevision === selectedSource.mappingRevision);
  const retryPreview = importState === "retryable" && retryCommand?.kind === "preview" && matchingRetrySource;
  const retryReview = importState === "retryable" && retryCommand?.kind === "review" && matchingRetrySource;
  const savedReceiptFence = savedReceipt ? receiptFenceFor(savedReceipt) : null;
  const lastReceiptFence = lastReceipt ? receiptFenceFor(lastReceipt) : null;
  const retryParentFence = retryCommand?.parent ? receiptFenceFor(retryCommand.parent) : null;
  const mappingCurrent = () => !rehydrating.current && (!selectedSource || Boolean(renderedHydration && hydrated.current === renderedHydration &&
    renderedHydration.sourceId === selectedSource.sourceId && renderedHydration.configRevision === selectedSource.configRevision &&
    renderedHydration.mappingRevision === selectedSource.mappingRevision));
  const receiptCurrent = () => sourceCurrent() && mappingCurrent() && receiptProof !== null && receiptProofRef.current === receiptProof &&
    receiptProof.source === sourceResult && receiptProof.receipt === lastReceipt && selectedSource?.sourceId === lastReceipt?.sourceId;
  const previewCurrent = () => receiptCurrent() && lastReceipt?.kind === "CSV_PREVIEW" && selectedSource?.configRevision === lastReceipt.configRevision &&
    selectedSource?.mappingRevision === lastReceipt.mappingRevision;
  const eligibleRows = useMemo(
    () => (preview?.outcomes ?? []).filter(reviewable),
    [preview],
  );

  async function loadSources(signal = new AbortController().signal) {
    const issuance = ++sourceIssuance.current;
    sourceProof.current = null; sourceErrorProof.current = null; setSourceError(null); refreshSourceProof();
    const current = () => !signal.aborted && isCurrentScope() && sourceIssuance.current === issuance;
    try {
      const raw = await managedRead(sourceReads, signal, current, (live, completion) =>
        request<unknown>("/ingestion/sources", { redirect: "error" }, 8 * 1024 * 1024, undefined,
          { current: live, completion }, live, 200));
      const csvSources = decodeSources(raw, actor.customerId);
      if (!current()) throw new Error("Source access changed.");
      for (const source of csvSources) {
        const owner = sourceOwner(actor.customerId, source.sourceId), fence = configurationFences.get(owner);
        if (fence && source.configRevision >= fence.configRevision && source.mappingRevision >= fence.mappingRevision) {
          if (fence.instance === instance.current && fence.epoch === draftEpoch.current && source.configRevision === fence.configRevision &&
            source.mappingRevision === fence.mappingRevision && source.configuration.mapping.kind === "CSV" &&
            mappingFingerprint(source.configuration.projects, source.configuration.mapping) === fence.fingerprint) mappingDirty.current = false;
          configurationWrites.confirm(owner, fence.lease); configurationFences.delete(owner);
        }
      }
      if (initialSelectionPending.current) {
        initialSelectionPending.current = false;
        if (csvSources.length) setSelectedSourceId((existing) => current() ? existing || csvSources[0]!.sourceId : existing);
      }
      setSourceError(null);
      const result = { request, issuance, value: csvSources };
      sourceProof.current = result; setSourceResult(result);
      return csvSources;
    } catch (error) {
      if (current()) { const failure = { request, issuance }; sourceErrorProof.current = failure; setSourceError(failure); }
      throw error;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadSources(controller.signal)
      .catch(() => { /* The current read reports its own error. */ });
    return () => { controller.abort(); };
  }, [request]);

  useEffect(() => {
    if (!selectedSource || !sourceCurrent()) return;
    const mapping = selectedSource.configuration.mapping;
    if (mapping.kind !== "CSV") return;
    const previous = hydrated.current;
    const sameVersion = Boolean(previous && previous.sourceId === selectedSource.sourceId &&
      previous.configRevision === selectedSource.configRevision && previous.mappingRevision === selectedSource.mappingRevision);
    if (previous && previous.sourceId === selectedSource.sourceId &&
      (previous.configRevision !== selectedSource.configRevision || previous.mappingRevision !== selectedSource.mappingRevision) &&
      mappingDirty.current && !rehydrating.current) return;
    setSheet(mapping.sheet);
    setIdentityColumn(mapping.identityColumn);
    setProjectColumn(mapping.projectColumn);
    setSelectedProjects(selectedSource.configuration.projects.map((item) => item.projectId));
    setFields(mapping.fields.map((field) => ({ ...field })));
    if (!sameVersion) {
      setPreview(null); setReviewed(null); receiptProofRef.current = null; setReceiptProof(null);
      if (previous && previous.sourceId !== selectedSource.sourceId) setLastReceipt(null);
      setSelectedRows([]); setFile(null);
    }
    const proof = { sourceId: selectedSource.sourceId, configRevision: selectedSource.configRevision, mappingRevision: selectedSource.mappingRevision };
    hydrated.current = proof; setRenderedHydration(proof); mappingDirty.current = false; rehydrating.current = false;
  }, [selectedSource?.sourceId, selectedSource?.configRevision, selectedSource?.mappingRevision, mappingReload]);

  function newMapping() {
    if (mappingDirty.current) { setNoticeError(true); setNotice("Discard the current mapping draft before creating another mapping."); return; }
    initialSelectionPending.current = false;
    hydrated.current = null; setRenderedHydration(null); mappingDirty.current = false; rehydrating.current = false;
    setSelectedSourceId("");
    setNewSourceId(crypto.randomUUID());
    setSheet("Projects");
    setIdentityColumn("Issue ID");
    setProjectColumn("Project ID");
    setSelectedProjects([]);
    setFields([emptyField()]);
    setPreview(null);
    setReviewed(null);
    receiptProofRef.current = null; setReceiptProof(null); setLastReceipt(null);
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
    if (!sourceCurrent() || !mappingCurrent() || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration || !activeSourceId || !selectedProjects.length || !fields.length ||
      importWrites.state(configurationOwner, null) !== "available" || savedReceipt?.sourceId === activeSourceId) return;
    const owner = configurationOwner, epoch = draftEpoch.current, sourceId = activeSourceId;
    const lease = configurationWrites.begin(owner);
    if (!lease) { setNoticeError(true); setNotice("An earlier mapping change is pending or could not be confirmed. Check the source before making another change."); return; }
    beginOperation();
    receiptIssuance.current++;
    setMappingBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const existingReaders = new Map(
        (selectedSource?.configuration.projects ?? []).map((item) => [item.projectId, item.readers]),
      );
      const payload = {
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
      };
      const result = await request<{ sourceId: string; configRevision: number; mappingRevision: number }>("/ingestion/sources/configuration", {
        method: "POST", body: JSON.stringify(payload),
      }, 65536, undefined, undefined, isCurrentScope, 201);
      if (!isCurrentScope() || draftEpoch.current !== epoch || !record(result) || Object.keys(result).sort().join(",") !== "configRevision,mappingRevision,sourceId" ||
        typeof result.sourceId !== "string" || !csvUuid.test(result.sourceId) || result.sourceId.toLowerCase() !== sourceId.toLowerCase() ||
        !revision(result.configRevision) || !revision(result.mappingRevision) || result.mappingRevision > result.configRevision ||
        (selectedSource && (result.configRevision <= selectedSource.configRevision || result.mappingRevision < selectedSource.mappingRevision))) {
        configurationWrites.uncertain(owner, lease); return;
      }
      configurationFences.set(owner, { lease, configRevision: result.configRevision, mappingRevision: result.mappingRevision,
        fingerprint: mappingFingerprint(payload.projects, payload.mapping), instance: instance.current, epoch });
      setSelectedSourceId(result.sourceId);
      setNotice("Mapping saved. The server will recheck project access and source-reader permissions for each upload and review.");
      setNoticeError(false);
      try {
        const refreshed = await loadSources();
        if (!isCurrentScope() || draftEpoch.current !== epoch) return;
        const saved = refreshed.find((source) => source.sourceId === result.sourceId);
        if (!saved) setNotice("Mapping saved. This account does not currently have access to every configured project, so the source is not shown here.");
      } catch { /* The source retry remains available without resending the mapping. */ }
    } catch {
      configurationWrites.uncertain(owner, lease);
      if (isCurrentScope() && draftEpoch.current === epoch) {
        setNotice("The mapping change could not be confirmed. Check the source before making another change."); setNoticeError(true);
      }
    } finally {
      operation.current = false;
      setMappingBusy(false);
    }
  }

  async function fetchReceipt(saved: SavedReceipt, current: () => boolean, signal: AbortSignal) {
    const ticket = receiptFenceFor(saved);
    const admitted = () => current() && receiptFenceCurrent(saved, ticket);
    if (!selectedSource || selectedSource.sourceId !== saved.sourceId || selectedSource.configRevision < saved.configRevision ||
      selectedSource.mappingRevision < saved.mappingRevision || !admitted()) throw new Error("Receipt is unavailable.");
    let dispatched = false, terminal = false;
    ticket!.active++;
    let raw: unknown;
    try {
      raw = await managedRead(receiptReads, signal, admitted, (live, completion) => {
        dispatched = true;
        return request<unknown>(`/ingestion/sources/${saved.sourceId}/receipts/${saved.receiptId}`, { redirect: "error" }, 8 * 1024 * 1024, (denied) => {
          if (denied && live()) { receiptFences.current.set(receiptKey(saved), { denied: true, active: 0, pinned: ticket!.pinned }); receiptProofRef.current = null;
            setReceiptError(true); setPreview(null); setReviewed(null); setSelectedRows([]); }
        }, { current: live, completion: (end) => { if (end === "eof" || end === "terminated") terminal = true; completion(end); } }, live, 200);
      });
    } finally { if (!dispatched || terminal) ticket!.active--; }
    const visibleProjectIds = new Set(projects.map((project) => project.id.toLowerCase()));
    const receipt = decodeReceipt(raw, saved, selectedSource.configuration.projects.map((project) => project.projectId)
      .filter((id) => visibleProjectIds.has(id.toLowerCase())));
    if (!admitted()) throw new Error("Receipt is unavailable.");
    return receipt;
  }
  function allowReceiptRetry(saved: SavedReceipt, ticket: ReceiptTicket | null) {
    if (!ticket || receiptFences.current.get(receiptKey(saved)) !== ticket) return false;
    if (ticket.denied) receiptFences.current.set(receiptKey(saved), { denied: false, active: 0, pinned: ticket.pinned });
    return true;
  }
  async function readSavedReceipt(saved: SavedReceipt) {
    const epoch = draftEpoch.current, fence = receiptFenceFor(saved);
    const current = () => sourceCurrent() && mappingCurrent() && draftCurrent() && draftEpoch.current === epoch &&
      confirmedReceipts.get(saved.owner) === saved && receiptFenceCurrent(saved, fence);
    const receipt = await fetchReceipt(saved, current, new AbortController().signal);
    if (!sourceResult || !current()) throw new Error("Receipt is unavailable.");
    editDraft(false);
    if (saved.kind === "CSV_PREVIEW") { setPreview(receipt); setReviewed(null); setSelectedRows([]);
      setNotice(`Preview saved with ${receipt.outcomes.length} rows. Select the eligible proposals you want to review.`); }
    else { setPreview(null); setReviewed(receipt); setNotice(`${saved.rowCount} reviewed proposal${saved.rowCount === 1 ? "" : "s"} saved. Canonical project facts were not changed.`); }
    const proof = { source: sourceResult, receipt: saved }; receiptProofRef.current = proof; setReceiptProof(proof); setLastReceipt(saved); setReceiptError(false);
    setNoticeError(false); confirmedReceipts.delete(saved.owner); importCommands.delete(saved.owner);
    const settledTicket = receiptFences.current.get(receiptKey(saved)); if (settledTicket) settledTicket.pinned = false;
    importWrites.confirm(saved.owner, saved.lease); refreshSavedReceipt();
  }

  useEffect(() => {
    if (!lastReceipt || !sourceResult || !sourceCurrent() || !mappingCurrent() || operation.current || savedReceipt || receiptCurrent() ||
      selectedSource?.sourceId !== lastReceipt.sourceId) return;
    const controller = new AbortController(), issuance = ++receiptIssuance.current, attempt = receiptAttempt;
    const epoch = draftEpoch.current, fence = receiptFenceFor(lastReceipt), current = () => !controller.signal.aborted && sourceCurrent() && mappingCurrent() &&
      draftEpoch.current === epoch && receiptIssuance.current === issuance && receiptAttemptRef.current === attempt && receiptFenceCurrent(lastReceipt, fence);
    if (!fence || fence.denied) { setReceiptError(true); return; }
    receiptProofRef.current = null; setReceiptError(false);
    void fetchReceipt(lastReceipt, current, controller.signal).then((receipt) => {
      if (!current()) return;
      if (lastReceipt.kind === "CSV_PREVIEW") {
        setPreview(receipt); setReviewed(null);
        const previous = new Map((preview?.outcomes ?? []).map((row) => [row.ordinal, JSON.stringify(row)]));
        const eligible = new Map(receipt.outcomes.filter(reviewable).map((row) => [row.ordinal, JSON.stringify(row)]));
        const retained = selectedRows.filter((row) => eligible.has(row) && previous.get(row) === eligible.get(row));
        setSelectedRows(retained);
        if (retained.length !== selectedRows.length) { setNoticeError(false); setNotice("The preview changed. Review and select the proposals again."); }
      } else { setPreview(null); setReviewed(receipt); }
      const proof = { source: sourceResult, receipt: lastReceipt }; receiptProofRef.current = proof; setReceiptProof(proof);
    }).catch(() => { if (current()) setReceiptError(true); });
    return () => { controller.abort(); };
  }, [sourceResult, lastReceipt, renderedHydration, renderedDraftEpoch, receiptAttempt, request, savedReceipt, selectedSource?.sourceId, busy, mappingBusy]);

  async function uploadAndPreview() {
    if (!sourceCurrent() || !mappingCurrent() || mappingDirty.current || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration || importWrites.snapshot() !== renderedImportVersion || !file || !selectedSource || savedReceipt ||
      configurationWrites.state(configurationOwner) !== "available") return;
    const owner = configurationOwner, epoch = draftEpoch.current, source = selectedSource;
    const state = importWrites.state(owner, null), existing = importCommands.get(owner), retry = state === "uncertain";
    if (retry ? existing !== retryCommand : importState !== "available" || retryCommand !== undefined) return;
    if (state !== "available" && (!retry || !existing || existing.kind !== "preview" || existing.subject !== actor.subject ||
      existing.sourceId !== source.sourceId || existing.configRevision !== source.configRevision || existing.mappingRevision !== source.mappingRevision)) return;
    let lease: symbol | null = null, reserved = false;
    beginOperation(); receiptIssuance.current++; let confirmed = false;
    setBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const current = () => sourceCurrent() && mappingCurrent() && draftCurrent() && draftEpoch.current === epoch;
      const prepared = await previewSnapshot(actor.subject, source, file, current), fingerprint = prepared.fingerprint;
      if (!current()) return;
      if (retry && fingerprint !== existing!.fingerprint) { setNoticeError(true); setNotice("Only the original preview can be retried."); return; }
      const commandKey = retry ? existing!.key : crypto.randomUUID();
      const command: ImportCommand = retry ? existing! : { kind: "preview", subject: actor.subject, key: commandKey, fingerprint,
        sourceId: source.sourceId, configRevision: source.configRevision, mappingRevision: source.mappingRevision };
      if (!current()) return;
      if (importWrites.snapshot() !== renderedImportVersion || configurationWrites.state(owner) !== "available" || confirmedReceipts.has(owner) ||
        importCommands.get(owner) !== existing || importWrites.state(owner, null) !== state) {
        setNoticeError(true); setNotice("Import activity changed. Review the source and try again."); return;
      }
      if (!reserveReceipt()) { setNoticeError(true); setNotice("Receipt access is at capacity. Reopen Data imports to try again."); return; }
      reserved = true;
      lease = importWrites.begin(owner, { key: commandKey, fingerprint });
      if (!lease) { setNoticeError(true); setNotice("An earlier source import operation is pending or could not be confirmed."); return; }
      importCommands.set(owner, command);
      const body = new FormData();
      body.set("file", prepared.body, "upload.csv");
      body.set("commandKey", commandKey);
      body.set("configRevision", String(selectedSource.configRevision));
      body.set("mappingRevision", String(selectedSource.mappingRevision));
      if (!current() || configurationWrites.state(owner) !== "available") { importWrites.uncertain(owner, lease); return; }
      const created = await request<unknown>(`/ingestion/sources/${source.sourceId}/csv-previews`,
        { method: "POST", body }, 65536, undefined, undefined, isCurrentScope, 201);
      if (!sourceCurrent() || !mappingCurrent() || !draftCurrent() || draftEpoch.current !== epoch || !record(created) ||
        !keys(created, ["receiptId", "replayed", "rowCount"]) || typeof created.receiptId !== "string" || !csvUuid.test(created.receiptId) ||
        typeof created.replayed !== "boolean" || !Number.isInteger(created.rowCount) || Number(created.rowCount) < 0 || Number(created.rowCount) > 1000)
        throw new Error("Preview outcome is unavailable.");
      const saved: SavedReceipt = { owner, lease, subject: actor.subject, sourceId: source.sourceId, receiptId: created.receiptId, kind: "CSV_PREVIEW", parent: null, rows: [],
        rowCount: Number(created.rowCount), configRevision: source.configRevision, mappingRevision: source.mappingRevision };
      assignReceipt(saved); reserved = false; confirmed = true;
      confirmedReceipts.set(owner, saved); refreshSavedReceipt(); await readSavedReceipt(saved);
    } catch {
      if (!confirmed && lease) importWrites.uncertain(owner, lease);
      if (sourceCurrent() && draftEpoch.current === epoch) { setNoticeError(true); setNotice(confirmed
        ? "Preview saved, but its receipt is unavailable."
        : lease ? "The preview could not be confirmed. Retry the same preview."
          : "The preview could not be prepared. Check the file and try again."); }
    } finally {
      if (reserved) receiptReservations.current--;
      operation.current = false;
      setBusy(false);
    }
  }

  async function commitReviewedRows(retryOriginal = false) {
    if (!sourceCurrent() || !mappingCurrent() || mappingDirty.current || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration || importWrites.snapshot() !== renderedImportVersion || !selectedSource || savedReceipt ||
      configurationWrites.state(configurationOwner) !== "available") return;
    const owner = configurationOwner, epoch = draftEpoch.current, source = selectedSource, existing = importCommands.get(owner);
    const state = importWrites.state(owner, null);
    if (retryOriginal) {
      if (state !== "uncertain" || !existing || existing.kind !== "review" || existing.subject !== actor.subject || !existing.parent || !existing.rows ||
        existing !== retryCommand || existing.sourceId !== source.sourceId || existing.configRevision !== source.configRevision || existing.mappingRevision !== source.mappingRevision) return;
      if (!allowReceiptRetry(existing.parent, retryParentFence)) return;
    } else if (state !== "available" || !previewCurrent() || !preview || !lastReceipt || !selectedRows.length) return;
    const parentReceipt = retryOriginal ? existing!.parent! : lastReceipt!, parent = parentReceipt.receiptId;
    const rows = retryOriginal ? [...existing!.rows!] : [...selectedRows].sort((left, right) => left - right);
    if (!unique(rows.map(String))) return;
    let lease: symbol | null = null, reserved = false;
    beginOperation(); receiptIssuance.current++; let confirmed = false;
    setBusy(true);
    setNotice("");
    setNoticeError(false);
    try {
      const fence = retryOriginal ? receiptFenceFor(parentReceipt) : null;
      const current = () => sourceCurrent() && mappingCurrent() && draftCurrent() && draftEpoch.current === epoch &&
        (!retryOriginal || receiptFenceCurrent(parentReceipt, fence));
      const parentView = retryOriginal ? await fetchReceipt(parentReceipt, current, new AbortController().signal) : preview!;
      const eligible = new Set(parentView.outcomes.filter((row) => retryOriginal
        ? row.state === "ACCEPTED" && row.errorCodes.length === 0 && ["CREATE", "UPDATE", "UNCHANGED"].includes(row.operation)
        : reviewable(row)).map((row) => row.ordinal));
      if (!current() || rows.some((row) => !eligible.has(row))) throw new Error("The original preview is unavailable.");
      const fingerprint = await reviewFingerprint(actor.subject, source, parent, rows);
      if (!current() || (!retryOriginal && !previewCurrent())) return;
      if (retryOriginal && fingerprint !== existing!.fingerprint) throw new Error("The original review is unavailable.");
      const commandKey = retryOriginal ? existing!.key : crypto.randomUUID();
      const command: ImportCommand = retryOriginal ? existing! : { kind: "review", subject: actor.subject, key: commandKey, fingerprint,
        sourceId: source.sourceId, configRevision: source.configRevision, mappingRevision: source.mappingRevision, parent: parentReceipt, rows };
      if (!current()) return;
      if (importWrites.snapshot() !== renderedImportVersion || configurationWrites.state(owner) !== "available" || confirmedReceipts.has(owner) ||
        importCommands.get(owner) !== existing || importWrites.state(owner, null) !== state || (!retryOriginal && !previewCurrent())) {
        setNoticeError(true); setNotice("Import activity changed. Review the source and try again."); return;
      }
      if (!reserveReceipt(fence)) { setNoticeError(true); setNotice("Receipt access is at capacity. Reopen Data imports to try again."); return; }
      reserved = true;
      lease = importWrites.begin(owner, { key: commandKey, fingerprint });
      if (!lease) { setNoticeError(true); setNotice("An earlier source import operation is pending or could not be confirmed."); return; }
      importCommands.set(owner, command);
      if (!current() || configurationWrites.state(owner) !== "available") { importWrites.uncertain(owner, lease); return; }
      const result = await request<unknown>(
        `/ingestion/sources/${source.sourceId}/reviewed-imports`,
        {
          method: "POST",
          body: JSON.stringify({
            previewReceiptId: parent,
            rowOrdinals: rows,
            commandKey,
          }),
        }, 65536, undefined, undefined, isCurrentScope, 201,
      );
      if (!sourceCurrent() || !mappingCurrent() || !draftCurrent() || draftEpoch.current !== epoch || !record(result) ||
        !keys(result, ["receiptId", "parentPreviewReceiptId", "replayed", "rowCount"]) || typeof result.receiptId !== "string" || !csvUuid.test(result.receiptId) ||
        result.parentPreviewReceiptId !== parent || typeof result.replayed !== "boolean" || result.rowCount !== rows.length) throw new Error("Review outcome is unavailable.");
      const saved: SavedReceipt = { owner, lease, subject: actor.subject, sourceId: source.sourceId, receiptId: result.receiptId, kind: "CSV_REVIEWED_IMPORT", parent, rows,
        rowCount: rows.length, configRevision: source.configRevision, mappingRevision: source.mappingRevision };
      assignReceipt(saved); reserved = false; confirmed = true;
      confirmedReceipts.set(owner, saved); refreshSavedReceipt(); await readSavedReceipt(saved);
    } catch {
      if (!confirmed && lease) importWrites.uncertain(owner, lease);
      if (sourceCurrent() && draftEpoch.current === epoch) { setNoticeError(true); setNotice(confirmed
        ? "Reviewed proposals were saved, but their receipt is unavailable."
        : lease ? "The reviewed import could not be confirmed. Retry the original selection."
          : "The original preview or review could not be verified."); }
    } finally {
      if (reserved) receiptReservations.current--;
      operation.current = false;
      setBusy(false);
    }
  }

  async function retrySavedReceipt() {
    if (!savedReceipt || !sourceCurrent() || !mappingCurrent() || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration ||
      receiptIssuance.current !== renderedReceiptIssuance || confirmedReceipts.get(savedReceipt.owner) !== savedReceipt) return;
    if (!allowReceiptRetry(savedReceipt, savedReceiptFence)) return;
    const epoch = draftEpoch.current; beginOperation(); receiptIssuance.current++; setBusy(true);
    try { await readSavedReceipt(savedReceipt); }
    catch { if (sourceCurrent() && draftEpoch.current === epoch) { setNoticeError(true); setNotice("The saved receipt is unavailable."); } }
    finally { operation.current = false; setBusy(false); }
  }

  return (
    <div className="csv-ingestion" onChangeCapture={(event) => {
      if (!sourceCurrent() || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration) { event.stopPropagation(); return; }
      if (event.target instanceof Element && event.target.closest(".csv-preview-panel") &&
        (!previewCurrent() || mappingDirty.current || importWrites.state(configurationOwner, null) !== "available" || !!savedReceipt)) {
        event.stopPropagation(); return;
      }
      editDraft(event.target instanceof Element && Boolean(event.target.closest(".csv-mapping-form")));
    }}>
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
      {sourceError && <p role="alert">Source list is unavailable. <Button className="secondary" disabled={busy || mappingBusy} onClick={() => {
        if (!isCurrentScope() || busy || mappingBusy || operation.current || sourceErrorProof.current !== sourceError || sourceError.request !== request ||
          sourceError.issuance !== sourceIssuance.current) return;
        sourceErrorProof.current = null;
        void loadSources().catch(() => { /* The current read reports its own error. */ });
      }}>Retry sources</Button></p>}
      {!sourceCurrent() && notice && <Message error={noticeError}>{notice}</Message>}
      {!sourceCurrent() && !sourceError && <p role="status">Checking source access…</p>}
      <div hidden={!sourceCurrent()} onClickCapture={(event) => {
        if (!sourceCurrent() || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration) event.stopPropagation();
      }}>
      <fieldset className="csv-work-fields" disabled={busy || mappingBusy}>
      {lastReceipt && !receiptCurrent() && !savedReceipt && <p role={receiptError ? "alert" : "status"}>
        {receiptError ? "The receipt is unavailable." : "Checking receipt access…"}
        {receiptError && lastReceiptFence && <Button className="secondary" onClick={() => {
          if (!sourceCurrent() || !mappingCurrent() || busy || mappingBusy || receiptAttemptRef.current !== receiptAttempt || receiptIssuance.current !== renderedReceiptIssuance || !receiptError) return;
          if (!lastReceipt || !allowReceiptRetry(lastReceipt, lastReceiptFence)) return;
          receiptAttemptRef.current++; setReceiptAttempt(receiptAttemptRef.current);
        }}>Retry receipt access</Button>}
      </p>}
      {!mappingCurrent() && selectedSource && <p role="alert">The source mapping changed. Reload it to discard the current draft and review the new revision. <Button className="secondary" onClick={() => {
        if (!sourceCurrent() || operation.current) return; rehydrating.current = true; setMappingReload((value) => value + 1);
      }}>Reload mapping</Button></p>}
      {mappingDirty.current && mappingCurrent() && <p>The mapping has unsaved changes. <Button className="secondary" onClick={() => {
        if (!sourceCurrent() || operation.current) return;
        editDraft(false);
        if (selectedSource) { rehydrating.current = true; setMappingReload((value) => value + 1); }
        else { mappingDirty.current = false; newMapping(); }
      }}>Discard mapping draft</Button></p>}

      <div className="detail-grid csv-ingestion-grid">
        <section className="panel">
          <div className="csv-panel-heading">
            <div>
              <h2>Import mapping</h2>
              <p className="muted">Choose the project scope and map CSV columns to proposal fields.</p>
            </div>
            <Button className="secondary" disabled={!!savedReceipt} onClick={() => { editDraft(false); newMapping(); }}>New mapping</Button>
          </div>
          {sources.length > 0 && (
            <SelectField
              label="Configured source"
              value={selectedSourceId}
              disabled={!!savedReceipt}
              onChange={(event) => { if (mappingDirty.current && event.target.value !== selectedSourceId) {
                setNoticeError(true); setNotice("Discard the current mapping draft before switching sources."); return;
              } initialSelectionPending.current = false; setSelectedSourceId(event.target.value); }}
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
              <Button className="secondary" onClick={() => { editDraft(true); setFields((current) => [...current, { ...emptyField(), column: "" }]); }}>Add field</Button>
            </div>
            {fields.map((field, index) => (
              <div className="csv-field-row" key={index}>
                <TextField label="CSV column" required maxLength={256} value={field.column} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, column: event.target.value } : item))} />
                <TextField label="Proposal field" required maxLength={96} pattern="[a-z][a-z0-9_.-]*" value={field.factType} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, factType: event.target.value } : item))} />
                <SelectField label="Value type" value={field.type} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, type: event.target.value as MappingField["type"] } : item))}>
                  <option value="text">Text</option><option value="date">Date</option><option value="number">Number</option><option value="boolean">Boolean</option>
                </SelectField>
                <label className="csv-required-option"><input type="checkbox" checked={field.required} onChange={(event) => setFields((current) => current.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} /> Required</label>
                <Button className="text-button" disabled={fields.length === 1} onClick={() => { editDraft(true); setFields((current) => current.filter((_, i) => i !== index)); }}>Remove</Button>
              </div>
            ))}
            <div className="actions">
              <Button type="submit" className="primary" disabled={!mappingCurrent() || mappingBusy || busy || !!savedReceipt || configurationState !== "available" || importState !== "available" || !selectedProjects.length || !fields.length}>
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
                <input type="file" accept=".csv,text/csv" disabled={!!savedReceipt} onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setReviewed(null);
                  receiptProofRef.current = null; setReceiptProof(null); setLastReceipt(null);
                  setSelectedRows([]);
                }} />
              </label>
              <div className="actions">
                <Button className="primary" disabled={!mappingCurrent() || mappingDirty.current || !file || busy || !!savedReceipt || configurationState !== "available" || (importState !== "available" && !retryPreview)} onClick={() => void uploadAndPreview()}>
                  {busy ? "Working…" : retryPreview ? "Retry same preview" : "Upload and preview"}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">Save a CSV mapping before uploading a file.</p>
          )}
          {notice && <Message error={noticeError}>{notice}</Message>}
          {savedReceipt && <Button className="secondary" disabled={busy || !savedReceiptFence} onClick={() => void retrySavedReceipt()}>Retry saved receipt</Button>}
          {configurationState !== "available" && <Message error={configurationState !== "pending"}>{configurationFences.has(configurationOwner)
            ? "Mapping saved; refresh the source list before continuing." : configurationState === "pending"
              ? "A mapping change is pending." : "An earlier mapping change could not be confirmed. Check the source before making another change."}</Message>}
          {importState !== "available" && <Message error={importState !== "pending"}>{savedReceipt
            ? "The import operation was saved; its receipt is awaiting review." : importState === "pending"
              ? "A source import operation is pending." : importState === "retryable"
                ? matchingRetrySource ? "The earlier import was not confirmed. Only its original command can be retried."
                  : "The earlier import was not confirmed. Its original configuration is no longer current, so it cannot be retried here."
                : "An earlier source import operation could not be confirmed. Check the source before making another change."}</Message>}
          {retryReview && <Button className="secondary" disabled={busy || !!savedReceipt || !mappingCurrent() || mappingDirty.current || !retryParentFence} onClick={() => void commitReviewedRows(true)}>Retry original reviewed selection</Button>}
          {configurationFence && <Button className="secondary" onClick={() => {
            if (!sourceCurrent() || !draftCurrent() || busy || mappingBusy || operation.current || operationGeneration.current !== renderedOperationGeneration ||
              configurationFences.get(configurationOwner) !== configurationFence) return;
            void loadSources().catch(() => { /* The current read reports its own error. */ });
          }}>Refresh source list</Button>}
        </section>
      </div>

      {preview && receiptCurrent() && (
        <section className="panel csv-preview-panel">
          {!previewCurrent() && <p role="alert">This preview used an earlier source configuration. Upload the file again before saving reviewed proposals.</p>}
          <div className="csv-panel-heading">
            <div>
              <h2>Preview {preview.receipt.id.slice(0, 8)}</h2>
              <p className="muted">Select only accepted rows with available proposal content. Invalid and ambiguous rows stay unselected.</p>
            </div>
            <Button className="secondary" disabled={!previewCurrent() || mappingDirty.current || !eligibleRows.length || importState !== "available" || !!savedReceipt} onClick={() => {
              if (!previewCurrent() || mappingDirty.current || !draftCurrent() || operation.current || !!savedReceipt || importWrites.state(configurationOwner, null) !== "available") return;
              editDraft(false); setSelectedRows(eligibleRows.map((row) => row.ordinal));
            }}>Select eligible rows</Button>
          </div>
          <div className="csv-table-wrap">
            <table className="csv-table">
              <thead><tr><th>Select</th><th>Row</th><th>Review state</th><th>Operation</th><th>Project</th><th>Proposal values</th></tr></thead>
              <tbody>
                {preview.outcomes.map((row) => {
                  const eligible = reviewable(row);
                  return (
                    <tr key={row.ordinal}>
                      <td><input type="checkbox" aria-label={`Select row ${row.ordinal}`} checked={selectedRows.includes(row.ordinal)} disabled={!previewCurrent() || mappingDirty.current || !eligible || !!reviewed || importState !== "available"} onChange={(event) => {
                        if (!previewCurrent() || mappingDirty.current || operation.current || importWrites.state(configurationOwner, null) !== "available" || !!savedReceipt) return;
                        const checked = event.target.checked;
                        setSelectedRows((current) => checked ? [...current, row.ordinal].sort((a, b) => a - b) : current.filter((ordinal) => ordinal !== row.ordinal));
                      }} /></td>
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
            <Button className="primary" disabled={!previewCurrent() || !mappingCurrent() || mappingDirty.current || !selectedRows.length || busy || !!reviewed || !!savedReceipt || configurationState !== "available" || importState !== "available"} onClick={() => void commitReviewedRows()}>
              {busy ? "Saving receipt…" : `Save ${selectedRows.length} reviewed proposal${selectedRows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </section>
      )}
      {reviewed && receiptCurrent() && <div className="csv-review-receipt" role="status">
        <strong>Reviewed import receipt saved</strong><span>{reviewed.receipt.id}</span>
        <small>Parent preview: {reviewed.receipt.parentPreviewReceiptId}</small><small>Canonical project facts were not changed.</small>
      </div>}
      </fieldset>
      </div>
    </div>
  );
}
