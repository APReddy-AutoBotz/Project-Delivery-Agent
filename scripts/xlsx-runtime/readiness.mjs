import {
  assertLinkDirectory,
  assertLiveEndpoint,
  retirementCode,
} from "./endpoint.mjs";

try {
  assertLinkDirectory();
  assertLiveEndpoint();
} catch {
  process.exitCode = retirementCode;
}
