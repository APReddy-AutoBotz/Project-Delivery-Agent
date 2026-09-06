// TR-DEP-003, TR-AUTH-001: disposable synthetic fixture; execute only in the test image.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const dir = "/fixture";
if (process.env.PDAA_ACCEPTANCE !== "isolated" || !existsSync(dir))
  throw new Error("Isolated fixture mount required");
if (existsSync(dir + "/ready"))
  throw new Error("Existing fixture must not be overwritten");
const write = (name, value) =>
  writeFileSync(`${dir}/${name}`, value, { mode: 0o644 });
// The nonroot operations job mounts this private directory as a whole.
execFileSync("chown", ["1000:1000", dir]);
for (const name of [
  "admin-password",
  "api-password",
  "worker-password",
  "migration-password",
  "backup-password",
  "login-password",
])
  write(name, randomBytes(32).toString("base64url") + "%40%25");
mkdirSync(dir + "/backups", { recursive: true });
execFileSync("chown", ["1000:1000", dir + "/backups"]);
write("backup-key", randomBytes(32).toString("base64"));
write("wrong-backup-key", randomBytes(32).toString("base64"));
write("encryption-key", randomBytes(32).toString("base64"));
const openssl = (...args) =>
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
for (const name of ["ca", "wrong-ca"])
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.crt`,
    "-days",
    "2",
    "-subj",
    `/CN=PDAA isolated ${name}`,
  );
openssl(
  "req",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  "server.key",
  "-out",
  "server.csr",
  "-subj",
  "/CN=gateway",
);
write(
  "server.ext",
  "subjectAltName=DNS:gateway,DNS:database,DNS:external-database,DNS:localhost\nextendedKeyUsage=serverAuth\n",
);
openssl(
  "x509",
  "-req",
  "-in",
  "server.csr",
  "-CA",
  "ca.crt",
  "-CAkey",
  "ca.key",
  "-CAcreateserial",
  "-out",
  "server.crt",
  "-days",
  "2",
  "-extfile",
  "server.ext",
);
// Docker Compose local file mounts do not apply uid/mode. Isolated directory only;
// the key is copied to PostgreSQL-owned 0600 storage by its entrypoint.
execFileSync("chmod", ["644", `${dir}/server.key`]);
const { readFileSync } = await import("node:fs");
const password = readFileSync(`${dir}/login-password`, "utf8");
const mapper = (name, type, config) => ({
  name,
  protocol: "openid-connect",
  protocolMapper: type,
  config,
});
const realm = {
  realm: "pdaa",
  enabled: true,
  sslRequired: "all",
  registrationAllowed: false,
  resetPasswordAllowed: false,
  accessTokenLifespan: 120,
  groups: ["project-managers", "leadership", "operators"].map((name) => ({
    name,
  })),
  clients: [
    {
      clientId: "pdaa-web",
      protocol: "openid-connect",
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      redirectUris: ["https://gateway:8443/auth/callback"],
      webOrigins: ["https://gateway:8443"],
      attributes: {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "https://gateway:8443",
      },
      defaultClientScopes: [],
      optionalClientScopes: ["pdaa.read"],
    },
  ],
  clientScopes: [
    {
      name: "pdaa.read",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true" },
      protocolMappers: [
        mapper("subject", "oidc-sub-mapper", { "access.token.claim": "true" }),
        mapper("api-audience", "oidc-audience-mapper", {
          "included.custom.audience": "pdaa-api",
          "access.token.claim": "true",
          "id.token.claim": "false",
        }),
        mapper("groups", "oidc-group-membership-mapper", {
          "claim.name": "groups",
          "full.path": "false",
          "access.token.claim": "true",
          "id.token.claim": "false",
          "userinfo.token.claim": "false",
        }),
      ],
    },
  ],
  users: [
    ["pm-atlas", "project-managers"],
    ["leader-atlas", "leadership"],
    ["operator", "operators"],
  ].map(([id, group]) => ({
    id,
    username: id,
    enabled: true,
    firstName: "Synthetic",
    lastName: id,
    email: `${id}@example.test`,
    emailVerified: true,
    requiredActions: [],
    groups: ["/" + group],
    credentials: [{ type: "password", value: password, temporary: false }],
  })),
};
mkdirSync(dir + "/realm", { recursive: true });
write("realm/pdaa-realm.json", JSON.stringify(realm));
write("ready", "isolated synthetic acceptance\n");
console.log(
  "Disposable credentials, certificates and identity fixture prepared; no values logged.",
);
