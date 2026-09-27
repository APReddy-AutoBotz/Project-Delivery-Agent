// Independent development validator: no Zod/runtime schema imports.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { isDeepStrictEqual } from "node:util";

function firstDifference(actual, expected, path = "$") {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return path;
    const length = Math.min(actual.length, expected.length);
    for (let index = 0; index < length; index++) {
      const difference = firstDifference(actual[index], expected[index], path + "[" + index + "]");
      if (difference) return difference;
    }
    return actual.length === expected.length ? path : path + ".length";
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key))
        return path + "[" + JSON.stringify(key) + "]";
      const difference = firstDifference(actual[key], expected[key], path + "[" + JSON.stringify(key) + "]");
      if (difference) return difference;
    }
  }
  return path;
}
export function assertContractSnapshot(actual, committed) {
  const normalized = JSON.parse(JSON.stringify(actual));
  const difference = firstDifference(normalized, committed);
  if (difference)
    throw new Error(
      "OpenAPI export differs from runtime at " + difference + "; regenerate and review the document",
    );
}
export function compileContract(document) {
  const ajv = new Ajv({ strict: true, allErrors: false });
  addFormats(ajv);
  // OpenAPI uses this media-specific marker for multipart file parts.
  ajv.addFormat("binary", () => true);
  const responses = new Map(),
    requests = new Map();
  for (const [path, item] of Object.entries(document.paths))
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ]) {
      const operation = item[method];
      if (!operation) continue;
      const key = method + " " + path;
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = response.content?.["application/json"]?.schema;
        if (!schema && status !== "204")
          throw new Error("Missing response schema: " + key + " " + status);
        responses.set(key + " " + status, schema ? ajv.compile(schema) : null);
      }
      if (operation.requestBody) {
        const validators = new Map(
          Object.entries(operation.requestBody.content ?? {}).map(
            ([mediaType, content]) => [mediaType, ajv.compile(content.schema)],
          ),
        );
        if (validators.size === 0)
          throw new Error("Missing request schema: " + key);
        requests.set(key, validators);
      }
    }
  return {
    request(method, path, value, contentType) {
      const validators = requests.get(method.toLowerCase() + " " + path);
      const mediaType = contentType?.split(";", 1)[0]?.trim()
        ?? (validators?.has("application/json") ? "application/json" : validators?.keys().next().value);
      const validate = mediaType ? validators?.get(mediaType) : undefined;
      if (!validate || !validate(value))
        throw new Error("Request violates published contract");
    },
    response(method, path, status, contentType, text) {
      const key = method.toLowerCase() + " " + path + " " + status;
      if (!responses.has(key)) throw new Error("Undocumented response: " + key);
      const validate = responses.get(key);
      if (validate === null) {
        if (text !== "") throw new Error("Body forbidden for empty response");
        return;
      }
      if (!contentType?.startsWith("application/json"))
        throw new Error("JSON response required");
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Response is not valid JSON");
      }
      if (!validate(value))
        throw new Error("Response violates published contract: " + key);
      return value;
    },
  };
}
