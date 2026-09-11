import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, TextField, SelectField, Message } from "./components.js";

export type RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;
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
}: {
  setup: ProjectSetup;
  request: RequestFn;
  onCreated: (id: string) => void;
  onCancel: () => void;
  onSetupChanged: () => Promise<void>;
}) {
  const [portfolioId, setPortfolio] = useState(setup.portfolios[0]?.id ?? "");
  const [programmeId, setProgramme] = useState("");
  const [createdProgramme, setCreatedProgramme] = useState<{
    id: string;
    code: string;
    name: string;
  } | null>(null);
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
  const [projectRequest, setProjectRequest] = useState<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [programme, setProgrammeDraft] = useState({ code: "", name: "" });
  const [programmeRequest, setProgrammeRequest] = useState<{
    code: string;
    name: string;
    idempotencyKey: string;
  } | null>(null);
  const portfolio = setup.portfolios.find((p) => p.id === portfolioId);
  const programmes = [...(portfolio?.programmes ?? [])];
  if (
    portfolio &&
    createdProgramme &&
    !programmes.some((p) => p.id === createdProgramme.id)
  )
    programmes.push(createdProgramme);
  const total = Object.values(rows).reduce(
    (sum, value) => sum + value.length,
    0,
  );
  const references = (collection: string) =>
    rows[collection]?.map((row) => row.fields.key!).filter(Boolean) ?? [];
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
    setError("");
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
    const payload = {
      portfolioId,
      programmeId: programmeId || null,
      ...fields,
      dates,
      ...Object.fromEntries(
        sections.map((section) => [
          section.key,
          rows[section.key]!.map((row) => rowPayload(section, row)),
        ]),
      ),
    };
    setPending({
      ...payload,
      idempotencyKey:
        projectRequest?.fingerprint === JSON.stringify(payload)
          ? projectRequest.key
          : crypto.randomUUID(),
    });
  }
  async function create() {
    if (!pending) return;
    setBusy(true);
    setError("");
    const { idempotencyKey, ...payload } = pending;
    setProjectRequest({
      fingerprint: JSON.stringify(payload),
      key: String(idempotencyKey),
    });
    try {
      const result = await request<{ id: string }>("/projects", {
        method: "POST",
        body: JSON.stringify(pending),
      });
      onCreated(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createProgramme() {
    if (!programme.code || !programme.name) return;
    setBusy(true);
    setError("");
    const payload = (programmeRequest?.code === programme.code &&
    programmeRequest?.name === programme.name
      ? programmeRequest
      : null) ?? {
      ...programme,
      idempotencyKey: crypto.randomUUID(),
    };
    setProgrammeRequest(payload);
    try {
      const created = await request<{ id: string; code: string; name: string }>(
        "/portfolios/" + portfolioId + "/programmes",
        { method: "POST", body: JSON.stringify(payload) },
      );
      setCreatedProgramme(created);
      await onSetupChanged();
      setProgramme(created.id);
      setProgrammeDraft({ code: "", name: "" });
      setProgrammeRequest(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
      {pending ? (
        <>
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
          <div className="actions">
            <Button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError("");
              }}
            >
              Edit details
            </Button>
            <Button
              className="primary"
              disabled={busy || !portfolio}
              onClick={() => void create()}
            >
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={review}>
          <fieldset disabled={busy}>
            <legend>Project overview</legend>
            <div className="form-row">
              <SelectField
                label="Portfolio"
                value={portfolioId}
                required
                onChange={(event) => {
                  setPortfolio(event.target.value);
                  setProgramme("");
                  setCreatedProgramme(null);
                  setProgrammeRequest(null);
                }}
              >
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
                  setProgramme(event.target.value);
                  setCreatedProgramme(
                    programmes.find((p) => p.id === event.target.value) ?? null,
                  );
                }}
              >
                <option value="">No programme</option>
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
                    setProgrammeDraft({
                      ...programme,
                      name: event.target.value,
                    });
                  }}
                />
              </div>
              <Button
                disabled={
                  busy || !programme.code || !programme.name || !portfolio
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
                      onClick={() =>
                        setRows((current) => ({
                          ...current,
                          [section.key]: current[section.key]!.filter(
                            (_, i) => i !== index,
                          ),
                        }))
                      }
                    >
                      Remove {section.singular} {index + 1}
                    </Button>
                  </fieldset>
                ))}
                <Button
                  className="secondary"
                  disabled={rows[section.key]!.length >= 50 || total >= 200}
                  onClick={() =>
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
                    }))
                  }
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
  request,
}: {
  id: string;
  request: RequestFn;
}) {
  const result = useQuery({
    queryKey: ["canonical-project", id],
    queryFn: () => request<Detail>("/projects/" + id + "/canonical"),
  });
  if (result.isError)
    return (
      <section className="panel">
        <Message error>{result.error.message}</Message>
      </section>
    );
  const detail = result.data;
  if (!detail) return <p role="status">Loading delivery structure…</p>;
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
    </section>
  );
}
