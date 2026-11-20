import { lstatSync, readFileSync } from "node:fs";
import { IsolatedXlsxDecoder, type Config } from "@pdaa/platform";

const bridge = "/usr/local/libexec/pdaa-xlsx-peer-bridge";
const directory = "/run/pdaa-xlsx";
const socket = directory + "/decoder.sock";
const peerUid = 1001;
const peerGid = 2000;

export function createConfiguredXlsxDecoder(
  mode: string | undefined,
  config: Pick<Config, "DEPLOYMENT_MODE" | "NODE_ENV" | "database">,
): IsolatedXlsxDecoder | undefined {
  if (mode === undefined) return undefined;
  try {
    if (
      mode !== "isolated" ||
      config.DEPLOYMENT_MODE !== "customer" ||
      config.NODE_ENV !== "production" ||
      config.database.user !== "pdaa_api" ||
      process.platform !== "linux" ||
      process.getuid?.() !== 1000 ||
      process.getgid?.() !== 1000 ||
      !process.getgroups?.().includes(peerGid)
    ) {
      throw new Error();
    }
    const helper = lstatSync(bridge);
    const mount = lstatSync(directory);
    const endpoint = lstatSync(socket);
    const mounts = readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .filter((fields) => fields[4] === directory);
    if (
      mounts.length !== 1 ||
      !mounts[0]?.[5]?.split(",").includes("ro") ||
      !helper.isFile() ||
      helper.uid !== 0 ||
      helper.gid !== 0 ||
      (helper.mode & 0o7777) !== 0o555 ||
      !mount.isDirectory() ||
      mount.uid !== peerUid ||
      mount.gid !== peerGid ||
      (mount.mode & 0o7777) !== 0o750 ||
      !endpoint.isSocket() ||
      endpoint.uid !== peerUid ||
      endpoint.gid !== peerGid ||
      (endpoint.mode & 0o7777) !== 0o660
    ) {
      throw new Error();
    }
    return new IsolatedXlsxDecoder({
      bridge,
      socket,
      peerUid,
      peerGid,
      timeoutMs: 9_000,
    });
  } catch {
    throw new Error("XLSX_DECODER_CONFIGURATION");
  }
}
