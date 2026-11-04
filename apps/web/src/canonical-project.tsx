import { LeadershipMilestoneConflict } from "./leadership-milestone-conflict.js";
import { useHealthScope } from "./health-scope-context.js";
import { decodeAssessmentConfirmation } from "./health-assessment-decoder.js";
import type { HealthWriteLease } from "./health-scope-fence.js";
import { LeadershipScalarConflict } from "./leadership-scalar-conflict.js";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { decodeCreatedProgramme, decodeCreatedProject } from "./canonical-creation-decoder.js";
import { canonicalCommandFingerprint, canonicalCreationOwner, programmeCreationWrites, projectCreationWrites } from "./canonical-creation-write-registry.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, TextField, SelectField, Message } from "./components.js";
import type { RequestFn } from "./request-types.js";
export type { RequestFn } from "./request-types.js";

export type ProjectSetup = {
  truncated: boolean;
  portfolios: {
    id: string;
    name: string;
    programmes: { id: string; code: string; name: string }[];
    programmesTruncated: boolean;
  }[];
};
type Dates = Record<string, string | null>;
type DraftRow = { rowId: string; fields: Record<string, string>; dates: Dates };
type Field = {
  name: string;
  label: string;
  max?: number;
  optional?: boolean;
  options?: string[];
};
type Section = {
  key: string;
  label: string;
  singular: string;
  dates?: boolean;
  fields: Field[];
};
const states = ["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"];
const reference = { name: "key", label: "Reference", max: 48 };
const sections: Section[] = [
  {
    key: "responsibilities",
    label: "Responsibilities",
    singular: "responsibility",
    fields: [
      {
        name: "role",
        label: "Responsibility",
        options: [
          "SPONSOR",
          "PROJECT_MANAGER",
          "SCRUM_MASTER",
          "TEAM_LEAD",
          "RESPONSIBLE_OWNER",
        ],
      },
      { name: "subject", label: "Account subject", max: 200 },
      { name: "displayName", label: "Display name", max: 160 },
    ],
  },
  {
    key: "sprints",
    label: "Sprints",
    singular: "sprint",
    dates: true,
    fields: [reference, { name: "name", label: "Sprint name", max: 160 }],
  },
  {
    key: "milestones",
    label: "Milestones",
    singular: "milestone",
    dates: true,
    fields: [
      reference,
      { name: "name", label: "Milestone name", max: 160 },
      { name: "state", label: "Declared state", options: states },
    ],
  },
  {
    key: "workItems",
    label: "Work items",
    singular: "work item",
    dates: true,
    fields: [
      reference,
      { name: "title", label: "Work item title", max: 160 },
      { name: "state", label: "Declared state", options: states },
      { name: "sprintKey", label: "Sprint reference", optional: true },
    ],
  },
  {
    key: "requiredWorkItems",
    label: "Required work links",
    singular: "required work link",
    fields: [
      { name: "milestoneKey", label: "Milestone reference" },
      { name: "workItemKey", label: "Work item reference" },
    ],
  },
  {
    key: "raidItems",
    label: "Risks, decisions and actions",
    singular: "risk or action record",
    fields: [
      reference,
      {
        name: "kind",
        label: "Record type",
        options: [
          "RISK",
          "ASSUMPTION",
          "ISSUE",
          "DEPENDENCY",
          "DECISION",
          "ACTION",
        ],
      },
      { name: "title", label: "Record title", max: 160 },
      {
        name: "description",
        label: "Record description",
        max: 4096,
        optional: true,
      },
      { name: "state", label: "Declared state", options: states },
      {
        name: "ownerSubject",
        label: "Owner account subject",
        max: 200,
        optional: true,
      },
    ],
  },
  {
    key: "sourceMappings",
    label: "Source references",
    singular: "source reference",
    fields: [
      { name: "sourceSystem", label: "Source system", max: 64 },
      { name: "instanceKey", label: "Source instance reference", max: 48 },
      { name: "externalType", label: "Source record type", max: 64 },
      { name: "externalId", label: "Source record identifier", max: 200 },
      {
        name: "externalRevision",
        label: "Source revision",
        max: 128,
        optional: true,
      },
      { name: "url", label: "Source URL", max: 2048, optional: true },
      {
        name: "targetType",
        label: "Target record type",
        options: ["PROJECT", "SPRINT", "MILESTONE", "WORK_ITEM", "RAID_ITEM"],
      },
      { name: "targetKey", label: "Target reference", optional: true },
    ],
  },
];
const categories = ["baseline", "planned", "forecast", "actual"];
const label = (value: string) =>
  value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
const emptyDates = (): Dates =>
  Object.fromEntries(
    categories.flatMap((category) =>
      ["Start", "End"].map((side) => [category + side, null]),
    ),
  );
function DateFields({
  value,
  onChange,
}: {
  value: Dates;
  onChange: (value: Dates) => void;
}) {
  return (
    <div className="canonical-dates">
      {categories.map((category) => (
        <fieldset key={category}>
          <legend>{label(category)} dates</legend>
          <div className="form-row">
            {["Start", "End"].map((side) => (
              <TextField
                key={side}
                label={label(category) + " " + side.toLowerCase()}
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={value[category + side] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...value,
                    [category + side]: event.target.value || null,
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
function DateDisplay({ dates }: { dates: Dates }) {
  return (
    <dl className="canonical-date-display">
      {categories.map((category) => (
        <div key={category}>
          <dt>{label(category)}</dt>
          <dd>
            {dates[category + "Start"] ?? "Unknown"} →{" "}
            {dates[category + "End"] ?? "Unknown"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function rowPayload(section: Section, row: DraftRow) {
  const nullable = [
    "sprintKey",
    "ownerSubject",
    "externalRevision",
    "url",
    "targetKey",
  ];
  return {
    ...Object.fromEntries(
      Object.entries(row.fields).map(([key, value]) => [
        key,
        nullable.includes(key) && !value ? null : value,
      ]),
    ),
    ...(section.dates ? { dates: row.dates } : {}),
  };
}
export function CreateProject({
  setup,
  request,
  onCreated,
  onCancel,
  onSetupChanged,
  isCurrentScope,
  isCurrentIdentity,
  customerId,
  subject,
}: {
  setup: ProjectSetup;
  request: RequestFn;
  onCreated: (id: string) => void;
  onCancel: () => void;
  onSetupChanged: () => Promise<ProjectSetup>;
  isCurrentScope: () => boolean;
  isCurrentIdentity: () => boolean;
  customerId: string;
  subject: string;
}) {
  const alive = useRef(true), operation = useRef(false);
  const selectionEpoch = useRef(0), reviewedSelectionEpoch = useRef(-1);
  const draftEpoch = useRef(0), reviewedDraftEpoch = useRef(-1), programmeEditEpoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [portfolioId, setPortfolio] = useState(setup.portfolios[0]?.id ?? "");
  useSyncExternalStore(projectCreationWrites.subscribe, projectCreationWrites.snapshot, projectCreationWrites.snapshot);
  useSyncExternalStore(programmeCreationWrites.subscribe, programmeCreationWrites.snapshot, programmeCreationWrites.snapshot);
  const creationOwner = canonicalCreationOwner(customerId, portfolioId);
  const [programmeId, setProgramme] = useState("");
  const [createdProgramme, setCreatedProgramme] = useState<{
    id: string;
    code: string;
    name: string;
  } | null>(null);
  const [programmeReceipt, setProgrammeReceipt] = useState<{ id: string; portfolioId: string } | null>(null);
  const [fields, setFields] = useState({
    code: "",
    name: "",
    description: "",
    reportedStatus: "UNKNOWN",
  });
  const [dates, setDates] = useState(emptyDates);
  const [rows, setRows] = useState<Record<string, DraftRow[]>>(() =>
    Object.fromEntries(sections.map((section) => [section.key, []])),
  );
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [projectDigest, setProjectDigest] = useState<{ pending: Record<string, unknown>; digest: string } | null>(null);
  const [projectDigestError, setProjectDigestError] = useState(false);
  useEffect(() => {
    let current = true;
    setProjectDigest(null); setProjectDigestError(false);
    if (pending) void canonicalCommandFingerprint(subject, JSON.stringify(pending)).then((digest) => {
      if (current) setProjectDigest({ pending, digest });
    }, () => { if (current) setProjectDigestError(true); });
    return () => { current = false; };
  }, [pending, subject]);
  const [projectRequest, setProjectRequest] = useState<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [programme, setProgrammeDraft] = useState({ code: "", name: "" });
  const [programmeRequest, setProgrammeRequest] = useState<{
    portfolioId: string;
    code: string;
    name: string;
    idempotencyKey: string;
  } | null>(null);
  const [programmeDigest, setProgrammeDigest] = useState<{ command: NonNullable<typeof programmeRequest>; digest: string } | null>(null);
  const projectCommand = pending && projectDigest?.pending === pending && typeof pending.idempotencyKey === "string"
    ? { key: pending.idempotencyKey, fingerprint: projectDigest.digest } : null;
  const programmeRetry = programmeRequest?.portfolioId === portfolioId && programmeRequest.code === programme.code && programmeRequest.name === programme.name
    ? programmeRequest : null;
  const programmeCommand = programmeRetry && programmeDigest?.command === programmeRetry
    ? { key: programmeRetry.idempotencyKey, fingerprint: programmeDigest.digest } : null;
  const projectWriteState = projectCreationWrites.state(creationOwner, projectCommand);
  const programmeWriteState = programmeCreationWrites.state(creationOwner, programmeCommand);
  const portfolio = setup.portfolios.find((p) => p.id === portfolioId);
  const programmes = [...(portfolio?.programmes ?? [])];
  if (
    portfolio &&
    createdProgramme &&
    !programmes.some((p) => p.id === createdProgramme.id)
  )
    programmes.push(createdProgramme);
  const selectionCurrent = Boolean(portfolio && (!programmeId || portfolio.programmes.some((p) => p.id === programmeId) ||
    (portfolio.programmesTruncated && programmeReceipt?.id === programmeId && programmeReceipt.portfolioId === portfolioId)));
  const total = Object.values(rows).reduce(
    (sum, value) => sum + value.length,
    0,
  );
  const references = (collection: string) =>
    rows[collection]?.map((row) => row.fields.key!).filter(Boolean) ?? [];
  const draftPayload = () => ({
    portfolioId, programmeId: programmeId || null, ...fields, dates,
    ...Object.fromEntries(sections.map((section) => [section.key, rows[section.key]!.map((row) => rowPayload(section, row))])),
  });
  const pendingMatchesDraft = (() => {
    if (!pending) return false;
    const reviewed = { ...pending }; delete reviewed.idempotencyKey;
    return reviewedSelectionEpoch.current === selectionEpoch.current && reviewedDraftEpoch.current === draftEpoch.current &&
      JSON.stringify(reviewed) === JSON.stringify(draftPayload());
  })();
  function choices(
    section: Section,
    field: Field,
    row: DraftRow,
  ): string[] | undefined {
    if (field.options) return field.options;
    if (field.name === "sprintKey") return references("sprints");
    if (field.name === "milestoneKey") return references("milestones");
    if (field.name === "workItemKey") return references("workItems");
    if (section.key === "sourceMappings" && field.name === "targetKey")
      return references(
        (
          {
            SPRINT: "sprints",
            MILESTONE: "milestones",
            WORK_ITEM: "workItems",
            RAID_ITEM: "raidItems",
          } as Record<string, string>
        )[row.fields.targetType!] ?? "",
      );
    return undefined;
  }
  function updateRow(
    section: string,
    index: number,
    change: Partial<DraftRow>,
  ) {
    setRows((current) => ({
      ...current,
      [section]: current[section]!.map((row, i) =>
        i === index ? { ...row, ...change } : row,
      ),
    }));
  }
  function review(event: React.FormEvent) {
    event.preventDefault();
    if (!isCurrentScope() || operation.current) return;
    setError("");
    if (!selectionCurrent) { setError("Choose a portfolio and programme available in the current setup."); return; }
    const allDates = [
      dates,
      ...sections
        .filter((s) => s.dates)
        .flatMap((s) => rows[s.key]!.map((r) => r.dates)),
    ];
    if (
      allDates.some((value) =>
        categories.some(
          (c) =>
            value[c + "Start"] &&
            value[c + "End"] &&
            value[c + "Start"]! > value[c + "End"]!,
        ),
      )
    ) {
      setError("Each end date must follow its corresponding start date.");
      return;
    }
    for (const section of sections.filter((s) =>
      s.fields.some((f) => f.name === "key"),
    )) {
      const refs = references(section.key);
      if (new Set(refs).size !== refs.length) {
        setError(section.label + " need distinct references.");
        return;
      }
    }
    for (const section of sections)
      for (const [index, row] of rows[section.key]!.entries()) {
        for (const field of section.fields) {
          const options = choices(section, field, row);
          const value = row.fields[field.name];
          if (!field.options && options && value && !options.includes(value)) {
            setError(
              `${label(section.singular)} ${index + 1}: choose an available ${field.label.toLowerCase()}.`,
            );
            return;
          }
        }
      }
    const payload = draftPayload();
    reviewedSelectionEpoch.current = selectionEpoch.current;
    reviewedDraftEpoch.current = draftEpoch.current;
    setPending({
      ...payload,
      idempotencyKey:
        projectRequest?.fingerprint === JSON.stringify(payload)
          ? projectRequest.key
          : crypto.randomUUID(),
    });
  }
  async function create() {
    if (!pending || !projectCommand || !pendingMatchesDraft || reviewedSelectionEpoch.current !== selectionEpoch.current || reviewedDraftEpoch.current !== draftEpoch.current ||
        !isCurrentScope() || !selectionCurrent || operation.current) return;
    const lease = projectCreationWrites.begin(creationOwner, projectCommand);
    if (!lease) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const { idempotencyKey, ...payload } = pending;
    setProjectRequest({
      fingerprint: JSON.stringify(payload),
      key: String(idempotencyKey),
    });
    try {
      const result = await request<unknown>("/projects", {
        method: "POST",
        body: JSON.stringify(pending),
      }, 1_048_576, undefined, undefined, undefined, 201);
      const value = decodeCreatedProject(result);
      if (!value)
        throw new Error("The project creation outcome could not be confirmed.");
      if (!isCurrentScope() || reviewedSelectionEpoch.current !== selectionEpoch.current || reviewedDraftEpoch.current !== draftEpoch.current)
        throw new Error("The project creation outcome could not be confirmed. Check access before retrying.");
      if (!projectCreationWrites.confirm(creationOwner, lease)) throw new Error("The project creation outcome could not be confirmed.");
      onCreated(value.id);
    } catch (e) {
      projectCreationWrites.uncertain(creationOwner, lease);
      if (alive.current) setError(isCurrentIdentity() ? (e as Error).message : "The project creation outcome could not be confirmed. Check access before retrying.");
    } finally {
      operation.current = false; if (alive.current) setBusy(false);
    }
  }
  async function createProgramme() {
    if (!isCurrentScope() || !portfolio || !programme.code || !programme.name || operation.current) return;
    const command = programmeRetry ?? {
      portfolioId,
      ...programme,
      idempotencyKey: crypto.randomUUID(),
    };
    const issuedSelectionEpoch = selectionEpoch.current, issuedProgrammeEditEpoch = programmeEditEpoch.current;
    operation.current = true;
    setBusy(true);
    setError("");
    setProgrammeRequest(command);
    let confirmed = false, lease: symbol | null = null;
    try {
      const { portfolioId: targetPortfolio, ...payload } = command;
      const fingerprint = await canonicalCommandFingerprint(subject, JSON.stringify(payload));
      if (!alive.current || !isCurrentScope() || selectionEpoch.current !== issuedSelectionEpoch || programmeEditEpoch.current !== issuedProgrammeEditEpoch)
        throw new Error("The programme details or setup changed before the request started.");
      setProgrammeDigest({ command, digest: fingerprint });
      lease = programmeCreationWrites.begin(creationOwner, { key: command.idempotencyKey, fingerprint });
      if (!lease) throw new Error("A previous programme creation must be checked before another request.");
      const response = await request<unknown>(
        "/portfolios/" + targetPortfolio + "/programmes",
        { method: "POST", body: JSON.stringify(payload) },
        1_048_576, undefined, undefined, undefined, 201,
      );
      const created = decodeCreatedProgramme(response);
      if (!created || created.code !== payload.code || created.name !== payload.name || !isCurrentScope() ||
          selectionEpoch.current !== issuedSelectionEpoch || programmeEditEpoch.current !== issuedProgrammeEditEpoch)
        throw new Error("The programme creation outcome could not be confirmed.");
      if (!programmeCreationWrites.confirm(creationOwner, lease)) throw new Error("The programme creation outcome could not be confirmed.");
      confirmed = true;
      setCreatedProgramme(created);
      setProgrammeReceipt({ id: created.id, portfolioId: targetPortfolio });
      setProgramme(created.id);
      const refreshed = await onSetupChanged();
      if (!isCurrentIdentity() || selectionEpoch.current !== issuedSelectionEpoch || programmeEditEpoch.current !== issuedProgrammeEditEpoch)
        throw new Error("Project setup access changed.");
      const refreshedPortfolio = refreshed.portfolios.find((p) => p.id === targetPortfolio);
      if (!refreshedPortfolio || (!refreshedPortfolio.programmesTruncated && !refreshedPortfolio.programmes.some((p) => p.id === created.id))) {
        setError("The programme was created, but is not in the current setup. Refresh or choose an available programme.");
        return;
      }
      setProgrammeDraft({ code: "", name: "" });
      setProgrammeRequest(null);
    } catch (e) {
      if (!confirmed && lease) programmeCreationWrites.uncertain(creationOwner, lease);
      if (alive.current) setError(confirmed
        ? "The programme was created, but project setup could not be refreshed. Check setup before continuing."
        : !lease ? (isCurrentIdentity() ? (e as Error).message : "No programme request was sent. Check access before retrying.")
          : isCurrentIdentity() ? (e as Error).message : "The programme creation outcome could not be confirmed. Check access before retrying.");
    } finally {
      operation.current = false; if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel canonical-form">
      <div className="section-title">
        <h2>{pending ? "Review project" : "Create project"}</h2>
        <Button className="text-button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="muted">
        Create a project workspace with its delivery structure. Reported
        information remains unassessed until evidence and delivery checks are
        available.
      </p>
      {error ? <Message error>{error}</Message> : null}
      {projectWriteState !== "available" && <Message error>A project creation is pending or could not be confirmed in this page. Check current records before reloading.</Message>}
      {programmeWriteState !== "available" && <Message error>A programme creation is pending or could not be confirmed in this page. Check current records before reloading.</Message>}
      {projectWriteState === "retryable" && <p>The same project request can be retried with its original key.</p>}
      {programmeWriteState === "retryable" && <p>The same programme request can be retried with its original key.</p>}
      {pending && !projectCommand && !projectDigestError && <p role="status">Preparing the reviewed project request…</p>}
      {pending && projectDigestError && <Message error>The reviewed project request could not be prepared. Edit the draft and try again.</Message>}
      {pending ? (
        <>
          {!pendingMatchesDraft && <Message error>Project details changed after review. Edit and review them again.</Message>}
          {!selectionCurrent && <Message error>The reviewed portfolio or programme is unavailable in the current setup. Edit the selection and review again.</Message>}
          <div hidden={!pendingMatchesDraft || !selectionCurrent}>
          <h3>
            {fields.name} · {fields.code}
          </h3>
          <p>
            {portfolio?.name}
            {programmeId
              ? " / " + programmes.find((p) => p.id === programmeId)?.name
              : ""}
          </p>
          <p>{fields.description}</p>
          <p>Reported status: {fields.reportedStatus} · Unassessed</p>
          <DateDisplay dates={dates} />
          {sections.map((section) => (
            <section key={section.key}>
              <h3>
                {section.label} ({rows[section.key]!.length})
              </h3>
              {rows[section.key]!.map((row) => (
                <div key={row.rowId} className="canonical-review-row">
                  <dl>
                    {section.fields.map((field) => (
                      <div key={field.name}>
                        <dt>{field.label}</dt>
                        <dd>
                          {row.fields[field.name]
                            ? field.options
                              ? label(row.fields[field.name]!)
                              : row.fields[field.name]
                            : "Not set"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {section.dates ? <DateDisplay dates={row.dates} /> : null}
                </div>
              ))}
            </section>
          ))}
          <p>
            Source references are configuration supplied by you. No source
            content has been retrieved or verified.
          </p>
          </div>
          <div className="actions">
            <Button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (!isCurrentScope()) return;
                reviewedDraftEpoch.current = -1;
                setPending(null);
                setError("");
              }}
            >
              Edit details
            </Button>
            <Button
              className="primary"
              disabled={busy || !projectCommand || !["available", "retryable"].includes(projectWriteState) || !pendingMatchesDraft || !selectionCurrent || !isCurrentScope()}
              onClick={() => void create()}
            >
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </>
      ) : (
          <form onSubmit={review} onChangeCapture={() => { draftEpoch.current++; }}>
          <fieldset disabled={busy || !isCurrentScope()}>
            <legend>Project overview</legend>
            <div className="form-row">
              <SelectField
                label="Portfolio"
                value={portfolioId}
                required
                onChange={(event) => {
                  selectionEpoch.current++;
                  setPortfolio(event.target.value);
                  setProgramme("");
                  setCreatedProgramme(null);
                  setProgrammeReceipt(null);
                  setProgrammeRequest(null);
                }}
              >
                {portfolioId && !portfolio && <option value={portfolioId}>Unavailable portfolio: {portfolioId}</option>}
                {setup.portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Programme"
                value={programmeId}
                onChange={(event) => {
                  selectionEpoch.current++;
                  setProgramme(event.target.value);
                  setCreatedProgramme(
                    programmes.find((p) => p.id === event.target.value) ?? null,
                  );
                }}
              >
                <option value="">No programme</option>
                {programmeId && !programmes.some((p) => p.id === programmeId) && <option value={programmeId}>Unavailable programme: {programmeId}</option>}
                {programmes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </SelectField>
            </div>
            {setup.truncated || portfolio?.programmesTruncated ? (
              <p role="status">
                The selection list is limited. Additional configuration is
                available through your administrator.
              </p>
            ) : null}
            <details>
              <summary>Create a programme in this portfolio</summary>
              <div className="form-row">
                <TextField
                  label="Programme code"
                  maxLength={48}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  value={programme.code}
                  onChange={(event) => {
                    programmeEditEpoch.current++;
                    setProgrammeDraft({
                      ...programme,
                      code: event.target.value,
                    });
                  }}
                />
                <TextField
                  label="Programme name"
                  maxLength={160}
                  value={programme.name}
                  onChange={(event) => {
                    programmeEditEpoch.current++;
                    setProgrammeDraft({
                      ...programme,
                      name: event.target.value,
                    });
                  }}
                />
              </div>
              <Button
                disabled={
                  busy || !["available", "retryable"].includes(programmeWriteState) || !programme.code || !programme.name || !portfolio
                }
                className="secondary"
                onClick={() => void createProgramme()}
              >
                Create programme
              </Button>
            </details>
            <div className="form-row">
              <TextField
                label="Project code"
                required
                maxLength={48}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                value={fields.code}
                onChange={(e) => setFields({ ...fields, code: e.target.value })}
              />
              <TextField
                label="Project name"
                required
                maxLength={160}
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
              />
            </div>
            <TextField
              label="Description"
              maxLength={4096}
              value={fields.description}
              onChange={(e) =>
                setFields({ ...fields, description: e.target.value })
              }
            />
            <SelectField
              label="Reported status"
              value={fields.reportedStatus}
              onChange={(e) =>
                setFields({ ...fields, reportedStatus: e.target.value })
              }
            >
              {["UNKNOWN", "GREEN", "AMBER", "RED"].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </SelectField>
            <DateFields value={dates} onChange={setDates} />
            {sections.map((section) => (
              <section className="canonical-section" key={section.key}>
                <h3>{section.label}</h3>
                {section.key === "responsibilities" ? (
                  <p className="muted">
                    Responsibilities identify people; they do not grant
                    application access.
                  </p>
                ) : section.key === "sourceMappings" ? (
                  <p className="muted">
                    Configure unverified source references. Source content is
                    not retrieved.
                  </p>
                ) : null}
                {rows[section.key]!.map((row, index) => (
                  <fieldset key={row.rowId} className="canonical-record">
                    <legend>
                      {label(section.singular)} {index + 1}
                    </legend>
                    <div className="form-row">
                      {section.fields.map((field) => {
                        const options = choices(section, field, row);
                        const required =
                          !field.optional ||
                          (section.key === "sourceMappings" &&
                            field.name === "targetKey" &&
                            row.fields.targetType !== "PROJECT");
                        const value = row.fields[field.name] ?? "";
                        return options ? (
                          <SelectField
                            key={field.name}
                            label={field.label}
                            required={required}
                            value={value}
                            onChange={(e) =>
                              updateRow(section.key, index, {
                                fields: {
                                  ...row.fields,
                                  [field.name]: e.target.value,
                                  ...(field.name === "targetType"
                                    ? { targetKey: "" }
                                    : {}),
                                },
                              })
                            }
                          >
                            {!field.options || field.optional ? (
                              <option value="">
                                {!required ? "Not set" : "Choose a reference"}
                              </option>
                            ) : null}
                            {!field.options &&
                            value &&
                            !options.includes(value) ? (
                              <option value={value}>
                                Unavailable reference: {value}
                              </option>
                            ) : null}
                            {options.map((value) => (
                              <option key={value} value={value}>
                                {field.options ? label(value) : value}
                              </option>
                            ))}
                          </SelectField>
                        ) : (
                          <TextField
                            key={field.name}
                            label={field.label}
                            required={!field.optional}
                            maxLength={field.max}
                            type={field.name === "url" ? "url" : "text"}
                            pattern={
                              field.name === "url"
                                ? "https://.*"
                                : field.name === "key" ||
                                    field.name === "instanceKey"
                                  ? "[A-Za-z0-9][A-Za-z0-9._-]*"
                                  : undefined
                            }
                            value={row.fields[field.name] ?? ""}
                            onChange={(e) =>
                              updateRow(section.key, index, {
                                fields: {
                                  ...row.fields,
                                  [field.name]: e.target.value,
                                },
                              })
                            }
                          />
                        );
                      })}
                    </div>
                    {section.dates ? (
                      <details>
                        <summary>Optional dates</summary>
                        <DateFields
                          value={row.dates}
                          onChange={(value) =>
                            updateRow(section.key, index, { dates: value })
                          }
                        />
                      </details>
                    ) : null}
                    <Button
                      className="text-button"
                      onClick={() => {
                        if (!isCurrentScope() || operation.current) return;
                        draftEpoch.current++;
                        setRows((current) => ({
                          ...current,
                          [section.key]: current[section.key]!.filter(
                            (_, i) => i !== index,
                          ),
                        }));
                      }}
                    >
                      Remove {section.singular} {index + 1}
                    </Button>
                  </fieldset>
                ))}
                <Button
                  className="secondary"
                  disabled={rows[section.key]!.length >= 50 || total >= 200}
                  onClick={() => {
                    if (!isCurrentScope() || operation.current) return;
                    draftEpoch.current++;
                    setRows((current) => ({
                      ...current,
                      [section.key]: [
                        ...current[section.key]!,
                        {
                          rowId: crypto.randomUUID(),
                          fields: Object.fromEntries(
                            section.fields.map((field) => [
                              field.name,
                              field.options?.[0] ?? "",
                            ]),
                          ),
                          dates: emptyDates(),
                        },
                      ],
                    }));
                  }}
                >
                  Add {section.singular}
                </Button>
              </section>
            ))}
            <div className="actions">
              <Button type="submit" className="primary" disabled={!portfolio}>
                Review project
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
type DetailRow = {
  id?: string;
  dates?: Dates;
  [key: string]: string | Dates | null | undefined;
};

type HealthAssessmentView = {
  assessmentId: string;
  projectId: string;
  assessedAt: string;
  coverage: "SCHEDULE_ONLY" | "SCHEDULE_AND_BLOCKER_AGE";
  ruleRevision: string;
  blockerAgeCoverage?: "COMPLETE" | "PARTIAL" | "UNASSESSABLE";
  envelopeHash: string;
  contentAvailable: boolean;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  replayed: boolean;
};
type HealthResult = {
  reported: { status: string; sourceFact: { source: { recordId: string } } };
  calculated: { status: string; rationale: { text: string } };
  contradiction: { severity: string; rationale: string } | null;
  objectiveSignals: {
    signalId: string;
    kind: string;
    targetType: string;
    targetKey: string;
    targetSource: { recordId: string };
    state: string;
    severity: string;
    rule: { parameters: { name: string; value: unknown }[] };
    sourceFacts: { field: string; value: unknown }[];
  }[];
};
function HealthAssessmentPanel({ id }: { id: string }) {
  const scope = useHealthScope();
  const latest = useQuery({
    queryKey: ["health-assessment-latest", ...scope.key],
    queryFn: ({ signal }) => scope.read<HealthAssessmentView | null>("/projects/" + id + "/health-assessments/latest", signal),
    enabled: scope.ready, staleTime: Infinity, gcTime: 0, refetchOnMount: false, refetchOnWindowFocus: false,
  });
  const assessment = useMutation({
    retry: false,
    mutationFn: async ({ key, lease }: { key: string; lease: HealthWriteLease }) => {
      let started = false;
      try {
        if (!scope.startAssessment(lease, key)) { scope.abandonUnsentAssessment(lease); return; }
        started = true;
        const response = await scope.write<unknown>(lease, "/projects/" + id + "/health-assessments", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandKey: key }),
        }, 201);
        decodeAssessmentConfirmation(response, id);
        if (!scope.writeCurrent(lease)) throw new Error("Assessment scope changed");
        scope.completeAssessment(lease, key);
      } catch { if (started) scope.markWriteUncertain(lease); }
      finally { scope.finishWrite(lease); }
    },
  });
  const run = () => {
    if (!latest.isSuccess || latest.isFetching) return;
    const admission = scope.beginAssessment(); if (!admission) return;
    try { assessment.mutate(admission); } catch { scope.abandonUnsentAssessment(admission.lease); scope.finishWrite(admission.lease); }
  };
  const value = latest.isFetching || latest.isError ? undefined : latest.data;
  const result = value?.contentAvailable && value.result
    ? (value.result as unknown as HealthResult)
    : null;
  if (!scope.ready || !scope.current()) return <section className="canonical-section">
    {scope.networkLimited ? <p role="alert">Health information is unavailable while earlier requests are pending or their cleanup is unconfirmed.</p>
      : scope.failed ? <><p role="alert">Current health access could not be established.</p>
        <Button className="secondary" onClick={() => scope.recheck()}>Check health access again</Button></>
        : <p role="status">Checking current health access…</p>}
  </section>;
  return (
    <section className="canonical-section" aria-labelledby="health-assessment-title">
      <h3 id="health-assessment-title">Schedule health assessment</h3>
      <p className="muted">
        Uses saved project configuration only. Source mappings and external systems are not retrieved or verified.
        The reported status is preserved separately from the schedule calculation. Any blocker-age coverage is stored
        separately and does not change the schedule result.
      </p>
      <Button onClick={run} disabled={!latest.isSuccess || latest.isFetching || assessment.isPending || !scope.canWrite || scope.atCapacity || scope.assessmentCapacity || scope.pendingAssessment}>
        {assessment.isPending ? "Assessing…" : scope.pendingAssessment ? "Assessment outcome unknown" : "Assess schedule"}
      </Button>
      {scope.uncertain && <p role="alert" className="error">A previous health write may still have an unknown outcome. Refreshed information is a separate as-of check.</p>}
      {scope.pendingAssessment && !assessment.isPending && <p role="alert" className="error">The assessment may have been saved. Check the saved assessment information before taking further action. This browser-session safeguard does not persist after a reload or across tabs.</p>}
      {!scope.canWrite && <p className="muted">Complete the current information checks before making changes.</p>}
      {(latest.isPending || latest.isFetching) && !value && <p role="status">Loading latest assessment…</p>}
      {latest.error && !value && <p role="alert" className="error">{latest.error.message}</p>}
      {!latest.isPending && !latest.isFetching && !latest.error && latest.data === null && <p className="muted">
        {scope.pendingAssessment ? "No saved assessment was available at the latest check; the earlier request may still complete." : "No assessment has been saved."}
      </p>}
      {value && (
        <div className="canonical-records">
          <div className="canonical-review-row">
            <p><strong>Assessed:</strong> {value.assessedAt} (UTC)</p>
            <p><strong>Assessment coverage:</strong> {value.coverage}</p>
            <p><strong>Schedule calculation scope:</strong> SCHEDULE_ONLY</p>
            {value.blockerAgeCoverage && (
              <p><strong>Blocker-age coverage:</strong> {value.blockerAgeCoverage}</p>
            )}
            <p><strong>Rule:</strong> {value.ruleRevision}</p>
            <p><strong>Envelope SHA-256:</strong> <code>{value.envelopeHash}</code></p>
          </div>
          {!value.contentAvailable || !result ? (
              <p className="muted">Assessment content is unavailable under current source access or retention.</p>
          ) : (
            <>
              <div className="canonical-review-row">
                <p>
                  <strong>Reported status:</strong> {result.reported.status}
                  {" "}· project record {result.reported.sourceFact.source.recordId}
                </p>
                <p><strong>Calculated schedule status:</strong> {result.calculated.status}</p>
                <p>
                  <strong>Calculation rationale:</strong>{" "}
                  {result.calculated.rationale.text}
                </p>
                {result.contradiction && (
                  <p role="status"><strong>Reported/calculated discrepancy ({result.contradiction.severity}):</strong> {result.contradiction.rationale}</p>
                )}
              </div>
              <ul>
                {result.objectiveSignals.map((signal) => (
                  <li key={signal.signalId}>
                    <strong>{signal.kind}</strong> · {signal.state} · {signal.severity}
                    <p>
                      Target: {signal.targetType} {signal.targetKey} · source ID{" "}
                      {signal.targetSource.recordId}
                    </p>
                    <p>
                      Rule inputs:{" "}
                      {signal.rule.parameters
                        .map((parameter) => parameter.name + "=" + String(parameter.value))
                        .join(", ") || "None"}
                    </p>
                    <ul>
                      {signal.sourceFacts.map((fact, index) => (
                        <li key={signal.signalId + "-" + fact.field + "-" + index}>
                          {fact.field}: {fact.value === null ? "Not set" : String(fact.value)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

type Detail = {
  id: string;
  configured: boolean;
  portfolio: { id: string; name: string };
  programme: { name: string } | null;
  dates: Dates;
  sourceMappingsWithheld: boolean;
  [key: string]: unknown;
};
export function CanonicalProjectDetails({
  id,
  leadershipScope,
  canInspectMilestoneRequest = false,
}: {
  id: string;
  leadershipScope?: string;
  canInspectMilestoneRequest?: boolean;
}) {
  const scope = useHealthScope();
  const [milestoneDraft, setMilestoneDraft] = useState({ selected: "", question: "" });
  const result = useQuery({
    queryKey: ["canonical-project", ...scope.key],
    // Preserve the existing canonical response contract; this endpoint has no
    // established encoded-size bound. Health responses retain their own cap.
    queryFn: ({ signal }) => scope.read<Detail>("/projects/" + id + "/canonical", signal, null),
    enabled: scope.ready, staleTime: Infinity, gcTime: 0, refetchOnMount: false, refetchOnWindowFocus: false,
  });
  if (!scope.ready || !scope.current()) return scope.networkLimited
    ? <p role="alert">Delivery structure is unavailable while earlier requests are pending or their cleanup is unconfirmed.</p>
    : scope.failed ? <section className="panel"><Message error>Current delivery structure access could not be established.</Message>
      <Button className="secondary" onClick={() => scope.recheck()}>Check delivery structure access again</Button></section>
      : <p role="status">Checking delivery structure access…</p>;
  if (result.isFetching) return <p role="status">Loading delivery structure…</p>;
  if (result.isError)
    return (
      <section className="panel">
        <Message error>{result.error.message}</Message>
        <Button className="secondary" disabled={scope.networkLimited} onClick={() => scope.refresh()}>Retry delivery structure</Button>
      </section>
    );
  const detail = result.data;
  if (!detail) return <p role="status">Loading delivery structure…</p>;
  // Leadership drivers capture one ticket-bound capability at mount. A new
  // health view must replace those drivers even when the project is unchanged.
  const leadershipViewScope = JSON.stringify([leadershipScope, ...scope.key]);
  const guardedRequest: RequestFn = async <T,>(path: string, init?: RequestInit, maxResponseBytes?: number, onUnavailable?: (denied?: boolean) => void): Promise<T> => {
    if (!scope.current()) throw new Error("Current access could not be established.");
    if ((init?.method ?? "GET").toUpperCase() !== "GET" || init?.body != null ||
      Object.keys(init ?? {}).some((key) => key !== "signal" && key !== "method"))
      throw new Error("Only scoped reads are supported.");
    const signal = init?.signal ?? new AbortController().signal;
    const value = await scope.read<T>(path, signal, maxResponseBytes ?? null, onUnavailable);
    if (!scope.current()) throw new Error("Current access could not be established.");
    return value;
  };
  return (
    <section className="panel canonical-detail">
      <h2>Delivery structure</h2>
      <p>
        {detail.portfolio.name}
        {detail.programme ? " / " + detail.programme.name : ""}
      </p>
      {!detail.configured ? (
        <p className="muted">
          No delivery structure has been configured for this project.
        </p>
      ) : (
        <>
          <DateDisplay dates={detail.dates} />
          {leadershipScope && !result.isFetching && !result.isError && <LeadershipMilestoneConflict
            key={leadershipViewScope} projectId={id} scope={leadershipViewScope} request={guardedRequest} reserveRead={scope.reserveRead}
            selected={milestoneDraft.selected} question={milestoneDraft.question} onDraftChange={setMilestoneDraft}
            canInspectRequest={canInspectMilestoneRequest}
            milestones={detail.milestones as { id: string; key: string; name: string }[]}
            workItems={detail.workItems as { id: string; key: string; title: string }[]} />}
          {leadershipScope && !result.isFetching && !result.isError && <LeadershipScalarConflict
            key={leadershipViewScope} projectId={id} scope={leadershipViewScope} request={guardedRequest} reserveRead={scope.reserveRead} />}
          {sections.map((section) => {
            const rows = detail[section.key] as DetailRow[];
            return (
              <section key={section.key}>
                <h3>{section.label}</h3>
                {section.key === "sourceMappings" ? (
                  <p className="muted">
                    {detail.sourceMappingsWithheld
                      ? "Source references are restricted to mapping administrators."
                      : "Unverified configuration references. Source content has not been retrieved."}
                  </p>
                ) : null}
                {rows.length ? (
                  <div className="canonical-records">
                    {rows.map((row, index) => (
                      <div
                        key={row.id ?? index}
                        className="canonical-review-row"
                      >
                        <dl>
                          {section.fields.map((field) => (
                            <div key={field.name}>
                              <dt>{field.label}</dt>
                              <dd>
                                {field.name === "url" &&
                                typeof row.url === "string" ? (
                                  <a
                                    href={row.url}
                                    rel="noopener noreferrer"
                                    target="_blank"
                                  >
                                    Open source reference
                                  </a>
                                ) : typeof row[field.name] === "string" ? (
                                  field.options ? (
                                    label(row[field.name] as string)
                                  ) : (
                                    ((row[field.name] || "Not set") as string)
                                  )
                                ) : (
                                  "Not set"
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        {row.dates ? <DateDisplay dates={row.dates} /> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    {section.key === "sourceMappings" &&
                    detail.sourceMappingsWithheld
                      ? "Unavailable to this account."
                      : "None configured."}
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
      <HealthAssessmentPanel id={id} />
    </section>
  );
}
