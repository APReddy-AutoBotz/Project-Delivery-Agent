// TR-DEP-001/003: isolated customer-mode configuration with synthetic fixtures.
import "./prepare.mjs";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const dir = "/fixture";
const openssl = (...args) =>
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
writeFileSync(
  dir + "/customer.ext",
  "subjectAltName=DNS:web,DNS:identity-ingress,DNS:database,DNS:external-database\nextendedKeyUsage=serverAuth\n",
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
  "customer.ext",
);
for (const [from, to] of [
  ["ca.crt", "database-ca.crt"],
  ["ca.crt", "identity-ca.crt"],
  ["server.crt", "database.crt"],
  ["server.key", "database.key"],
])
  copyFileSync(`${dir}/${from}`, `${dir}/${to}`);
const realm = JSON.parse(readFileSync(dir + "/realm/pdaa-realm.json", "utf8"));
realm.clients[0].redirectUris = ["https://web:8443/auth/callback"];
realm.clients[0].webOrigins = ["https://web:8443"];
realm.clients[0].attributes["post.logout.redirect.uris"] = "https://web:8443";
writeFileSync(dir + "/realm/pdaa-realm.json", JSON.stringify(realm));
writeFileSync(dir + "/customer-ready", "isolated customer composition\n");
