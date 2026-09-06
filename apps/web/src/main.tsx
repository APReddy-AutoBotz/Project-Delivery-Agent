import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { Button, TextField, SelectField, Message } from "./components.js";
import "./style.css";

type AuthConfig = {
  mode: "oidc" | "development";
  dataMode: string;
  issuer?: string;
  clientId?: string;
  scope: string;
  resource?: string;
};
type Actor = { subject: string; roles: string[] };
type Project = {
  id: string;
  code: string;
  name: string;
  description: string;
  reportedStatus: string;
};
type Platform = {
  database: string;
  worker: string;
  shadowMode: boolean;
  identityMode: string;
  dataMode: string;
};
type Audit = { id: string; event: string; actor: string; occurredAt: string };
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
// Tokens live only in memory. OIDC redirect state uses session storage and is removed by the callback.
let accessToken: string | undefined;
let idToken: string | undefined;
let oidc: UserManager | undefined;
let expireSession: (() => void) | undefined;
function useProtectedQuery<T>(options: UseQueryOptions<T>) {
  const query = useQuery(options);
  return { ...query, data: query.isError ? undefined : query.data };
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestToken = accessToken;
  const response = await fetch("/api" + path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(requestToken ? { Authorization: "Bearer " + requestToken } : {}),
    },
  });
  if (response.status === 401 && requestToken && requestToken === accessToken)
    expireSession?.();
  if (
    (response.status === 403 || response.status === 404) &&
    path.startsWith("/projects/")
  )
    void client.invalidateQueries({ queryKey: ["projects"] });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Your session has ended. Sign out and sign in again."
        : response.status === 404
          ? "This project is unavailable for your account."
          : response.status === 403
            ? "You do not have permission for this action."
            : "The request could not be completed. Please try again.",
    );
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
function manager(config: AuthConfig) {
  return (oidc ??= new UserManager({
    authority: config.issuer!,
    client_id: config.clientId!,
    redirect_uri: window.location.origin + "/auth/callback",
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: config.scope,
    resource: config.resource,
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({
      store: {
        get length() {
          return 0;
        },
        clear() {},
        getItem() {
          return null;
        },
        key() {
          return null;
        },
        removeItem() {},
        setItem() {},
      },
    }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  }));
}
function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"projects" | "platform">("projects");
  const [selected, setSelected] = useState<string | null>(null);
  React.useEffect(() => {
    expireSession = () => {
      accessToken = undefined;
      idToken = undefined;
      setSignedIn(false);
      setSelected(null);
      setView("projects");
      setError("Your session has ended. Please sign in again.");
      client.clear();
    };
    return () => {
      expireSession = undefined;
    };
  }, []);
  const auth = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => request<AuthConfig>("/auth/config"),
  });
  const me = useProtectedQuery({
    queryKey: ["me"],
    queryFn: () => request<Actor>("/me"),
    enabled: signedIn,
  });
  const projects = useProtectedQuery({
    queryKey: ["projects"],
    queryFn: () => request<Project[]>("/projects"),
    enabled: signedIn,
  });
  const project = useProtectedQuery({
    queryKey: ["project", selected],
    queryFn: () => request<Project>("/projects/" + selected),
    enabled: signedIn && !!selected,
  });
  const admin = me.data?.roles.some((r) =>
    ["system_admin", "pmo_admin"].includes(r),
  );
  async function login(persona?: string) {
    setBusy(true);
    setError("");
    try {
      if (auth.data?.mode === "development") {
        const result = await request<{ token: string }>("/auth/development", {
          method: "POST",
          body: JSON.stringify({ persona }),
        });
        accessToken = result.token;
        setSignedIn(true);
      } else if (auth.data) await manager(auth.data).signinRedirect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  React.useEffect(() => {
    if (
      window.location.pathname !== "/auth/callback" ||
      !auth.data ||
      auth.data.mode !== "oidc"
    )
      return;
    let active = true;
    manager(auth.data)
      .signinRedirectCallback()
      .then((user) => {
        if (active) {
          accessToken = user.access_token;
          idToken = user.id_token;
          window.history.replaceState({}, "", "/");
          setSignedIn(true);
        }
      })
      .catch(() => {
        if (active)
          setError("Sign-in could not be verified. Please try again.");
      });
    return () => {
      active = false;
    };
  }, [auth.data]);
  async function logout() {
    const logoutHint = idToken;
    idToken = undefined;
    accessToken = undefined;
    setSignedIn(false);
    setSelected(null);
    setView("projects");
    client.clear();
    if (auth.data?.mode === "oidc" && oidc) {
      try {
        await oidc.removeUser();
        await oidc.signoutRedirect({ id_token_hint: logoutHint });
      } catch {
        setError(
          "You are signed out of this application. Identity-provider sign-out could not be completed.",
        );
      }
    }
  }
  const displayName =
    me.data?.subject === "pm-atlas"
      ? "Atlas project manager"
      : me.data?.subject === "operator"
        ? "Platform operator"
        : me.data?.subject === "leader-atlas"
          ? "Atlas leadership"
          : me.data?.subject;
  if (!signedIn)
    return (
      <div className="login">
        <section className="login-story">
          <div className="brand">
            <span className="brand-mark">da</span> Delivery Assurance
          </div>
          <div className="story-copy">
            <span className="eyebrow">A CLEARER VIEW OF DELIVERY</span>
            <h1>
              Confidence starts
              <br />
              with evidence.
            </h1>
            <p>
              One place to understand project commitments, follow up on missing
              information, and keep decisions traceable.
            </p>
            <div className="story-line" />
            <small>Customer-hosted · Permission-aware · Human-approved</small>
          </div>
          <span className="login-footer">
            PROJECT DELIVERY ASSURANCE AGENT / FOUNDATION
          </span>
        </section>
        <main className="login-form">
          <span className="pill">
            {auth.data?.dataMode === "synthetic"
              ? "Synthetic workspace"
              : "Customer workspace"}
          </span>
          <h2>Welcome to your workspace</h2>
          <p className="muted">
            {auth.data?.mode === "development"
              ? "Explore the foundation with a sample account. All project information here is synthetic."
              : "Sign in with your organization to see projects shared with you."}
          </p>
          {(error || auth.error) && (
            <p role="alert" className="error">
              {error || "Unable to connect to the service."}
            </p>
          )}
          {auth.isPending ? (
            <p role="status">Connecting to your workspace…</p>
          ) : auth.data?.mode === "development" ? (
            <div className="personas">
              <Button disabled={busy} onClick={() => login("pm-atlas")}>
                <span>
                  <strong>Project manager</strong>
                  <small>View the Atlas project workspace</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
              <Button disabled={busy} onClick={() => login("leader-atlas")}>
                <span>
                  <strong>Leadership</strong>
                  <small>Review projects shared with you</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
              <Button disabled={busy} onClick={() => login("operator")}>
                <span>
                  <strong>Platform operator</strong>
                  <small>Manage access and check service health</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Button>
            </div>
          ) : (
            <Button
              className="primary"
              disabled={!auth.data || busy}
              onClick={() => login()}
            >
              Sign in with your organization
            </Button>
          )}
          <p className="login-note">
            {auth.data?.mode === "development"
              ? "Preview access is limited to this local development environment."
              : "Access follows your organization’s project and portfolio permissions."}
          </p>
        </main>
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">da</span>
          <span>
            Delivery
            <br />
            Assurance
          </span>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          <Button
            className={view === "projects" ? "active" : ""}
            onClick={() => {
              setView("projects");
              setSelected(null);
            }}
          >
            <span aria-hidden="true">▦</span> Projects
          </Button>
          {admin && (
            <Button
              className={view === "platform" ? "active" : ""}
              onClick={() => setView("platform")}
            >
              <span aria-hidden="true">⚙</span> Platform & access
            </Button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="scope-dot" /> Customer-hosted workspace
          <small>Foundation preview · v0.1</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span>{" "}
            {view === "projects" ? "Projects" : "Platform"}
          </span>
          <div>
            <span className="pill">
              {auth.data?.dataMode === "synthetic"
                ? "Synthetic data"
                : "Customer data"}
            </span>
            <Button className="text-button" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">DELIVERY ASSURANCE</span>
              <h1>
                {view === "platform"
                  ? "Platform & access"
                  : selected
                    ? (project.data?.name ?? "Project workspace")
                    : "Your projects"}
              </h1>
              <p className="muted">
                {view === "platform"
                  ? "Service health, scoped access, and a record of administrative changes."
                  : selected
                    ? "A shared starting point for project evidence and decisions."
                    : "A focused view of the projects you have permission to access."}
              </p>
            </div>
            <div className="account">
              <span className="avatar">{admin ? "OP" : "AT"}</span>
              <span>
                <strong>{displayName ?? "Loading account…"}</strong>
                <small>{me.data?.roles.join(", ").replaceAll("_", " ")}</small>
              </span>
            </div>
          </div>
          {me.error && (
            <p role="alert" className="error">
              {me.error.message}
            </p>
          )}
          {view === "platform" && admin ? (
            <PlatformView />
          ) : selected ? (
            <>
              <Button
                className="back text-button"
                onClick={() => setSelected(null)}
              >
                ← All projects
              </Button>
              {project.error ? (
                <p role="alert" className="error">
                  {project.error.message}
                </p>
              ) : project.data ? (
                <ProjectDetail project={project.data} />
              ) : (
                <p role="status">Loading project…</p>
              )}
            </>
          ) : (
            <>
              <div className="summary-strip">
                <div>
                  <span>Accessible projects</span>
                  <strong>{projects.data?.length ?? "—"}</strong>
                </div>
                <div>
                  <span>Evidence connections</span>
                  <strong>
                    0 <small>Awaiting setup</small>
                  </strong>
                </div>
                <div>
                  <span>Delivery assessment</span>
                  <strong className="quiet-value">Not yet available</strong>
                </div>
              </div>
              <div className="section-title">
                <h2>Project workspace</h2>
                <span>{projects.data?.length ?? 0} visible</span>
              </div>
              {projects.error && (
                <p role="alert" className="error">
                  {projects.error.message}
                </p>
              )}
              {projects.isPending ? (
                <p role="status">Loading projects…</p>
              ) : projects.data?.length ? (
                <div className="project-grid">
                  {projects.data.map((p) => (
                    <Button
                      key={p.id}
                      className="project-card"
                      onClick={() => setSelected(p.id)}
                    >
                      <div className="card-top">
                        <span className="project-code">{p.code}</span>
                        <span className="pill neutral">Awaiting evidence</span>
                      </div>
                      <h3>{p.name}</h3>
                      <p>{p.description}</p>
                      <div className="card-bottom">
                        <span>Open project workspace</span>
                        <span aria-hidden="true">↗</span>
                      </div>
                    </Button>
                  ))}
                </div>
              ) : (
                !projects.error && (
                  <div className="empty">
                    <h3>No projects are shared with this account</h3>
                    <p>
                      Ask an administrator for a project or portfolio grant.
                      Platform access does not automatically include project
                      data.
                    </p>
                  </div>
                )
              )}
              <div className="foundation-note">
                <span className="note-icon" aria-hidden="true">
                  i
                </span>
                <div>
                  <strong>Your evidence workspace starts here</strong>
                  <p>
                    Source connections, delivery checks, follow-ups, and
                    reporting will become available in later increments. No
                    delivery score has been calculated.
                  </p>
                </div>
              </div>
            </>
          )}
        </main>
        <footer>
          Delivery Assurance{" "}
          <span>Evidence first. Every action accountable.</span>
        </footer>
      </div>
    </div>
  );
}
function ProjectDetail({ project }: { project: Project }) {
  return (
    <div className="detail-grid">
      <section className="panel">
        <span className="eyebrow">PROJECT OVERVIEW</span>
        <h2>{project.name}</h2>
        <p className="muted">{project.description}</p>
        <dl>
          <div>
            <dt>Project reference</dt>
            <dd>{project.code}</dd>
          </div>
          <div>
            <dt>Reported status</dt>
            <dd>
              <span className="pill neutral">
                {project.reportedStatus} · Synthetic seed
              </span>
            </dd>
          </div>
          <div>
            <dt>Evidence freshness</dt>
            <dd>Unknown — no source connected</dd>
          </div>
          <div>
            <dt>Assessed health</dt>
            <dd>Not yet available</dd>
          </div>
        </dl>
      </section>
      <section className="panel next-step">
        <span className="eyebrow">NEXT MILESTONE</span>
        <h2>Connect the evidence</h2>
        <p>
          Source setup will bring traceable project updates into this workspace.
          Until then, delivery status remains unassessed.
        </p>
        <div className="timeline">
          <span>01</span>
          <div>
            <strong>Workspace & access</strong>
            <small>Foundation available</small>
          </div>
        </div>
        <div className="timeline muted">
          <span>02</span>
          <div>
            <strong>Evidence & delivery checks</strong>
            <small>Planned</small>
          </div>
        </div>
        <div className="timeline muted">
          <span>03</span>
          <div>
            <strong>Follow-ups & decisions</strong>
            <small>Planned</small>
          </div>
        </div>
      </section>
    </div>
  );
}
function PlatformView() {
  const status = useProtectedQuery({
    queryKey: ["platform"],
    queryFn: () => request<Platform>("/platform"),
    refetchInterval: 15000,
  });
  const audit = useProtectedQuery({
    queryKey: ["audit"],
    queryFn: () => request<Audit[]>("/audit"),
  });
  const [subject, setSubject] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [scopeType, setScopeType] = useState("project");
  const [role, setRole] = useState("contributor");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setMessageError(false);
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    try {
      await request("/access-grants", {
        method: action === "revoke" ? "DELETE" : "POST",
        body: JSON.stringify({
          subject,
          scopeType,
          scopeId,
          ...(action === "revoke" ? {} : { role }),
        }),
      });
      setMessage(
        action === "revoke"
          ? "Access revoked. The change is recorded in the audit log."
          : "Access granted. The change is recorded in the audit log.",
      );
      await client.invalidateQueries();
    } catch (e) {
      setMessageError(true);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="summary-strip">
        <div>
          <span>Database</span>
          <strong className="quiet-value">
            {status.data?.database ?? "Checking…"}
          </strong>
        </div>
        <div>
          <span>Background worker</span>
          <strong className="quiet-value">
            {status.data?.worker ?? "Checking…"}
          </strong>
        </div>
        <div>
          <span>Outbound actions</span>
          <strong className="quiet-value">
            {status.data
              ? status.data.shadowMode
                ? "Shadow mode"
                : "Policy controlled"
              : "Checking…"}
          </strong>
        </div>
      </div>
      {status.error && (
        <p role="alert" className="error">
          {status.error.message}
        </p>
      )}
      <div className="detail-grid">
        <section className="panel">
          <h2>Manage scoped access</h2>
          <p className="muted">
            Grant access to one project or portfolio using its identifier. Each
            change is recorded.
          </p>
          <form onSubmit={update}>
            <TextField
              label="Account subject"
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Identity provider subject"
            />
            <div className="form-row">
              <SelectField
                label="Scope"
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value)}
              >
                <option value="project">Project</option>
                <option value="portfolio">Portfolio</option>
              </SelectField>
              <SelectField
                label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {[
                  "contributor",
                  "project_manager",
                  "leadership",
                  "pmo_admin",
                  "system_admin",
                ].map((r) => (
                  <option key={r} value={r}>
                    {r.replaceAll("_", " ")}
                  </option>
                ))}
              </SelectField>
            </div>
            <TextField
              label="Scope identifier"
              required
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              placeholder="Project or portfolio UUID"
              pattern="[0-9a-fA-F-]{36}"
            />
            <div className="actions">
              <Button
                type="submit"
                className="primary"
                value="grant"
                disabled={busy}
              >
                Grant access
              </Button>
              <Button
                type="submit"
                className="secondary"
                value="revoke"
                disabled={busy}
              >
                Revoke access
              </Button>
            </div>
            {message && <Message error={messageError}>{message}</Message>}
          </form>
        </section>
        <section className="panel">
          <h2>Recent access changes</h2>
          <p className="muted">
            An append-only record of administrative actions.
          </p>
          {audit.error && (
            <p role="alert" className="error">
              {audit.error.message}
            </p>
          )}
          {audit.data?.length ? (
            <ul className="audit-list">
              {audit.data.map((a) => (
                <li key={a.id}>
                  <strong>
                    {a.event === "access.granted"
                      ? "Access granted"
                      : "Access revoked"}
                  </strong>
                  <span>{a.actor}</span>
                  <small>{new Date(a.occurredAt).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No administrative changes recorded yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
