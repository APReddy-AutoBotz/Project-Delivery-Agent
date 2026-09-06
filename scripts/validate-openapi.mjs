// Independent development validator: no Zod/runtime schema imports.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { isDeepStrictEqual } from "node:util";

export function assertContractSnapshot(actual, committed) {
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), committed))
    throw new Error(
      "OpenAPI export differs from runtime; regenerate and review the document",
    );
}
export function compileContract(document) {
  const ajv = new Ajv({ strict: true, allErrors: false });
  addFormats(ajv);
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
      if (operation.requestBody)
        requests.set(
          key,
          ajv.compile(operation.requestBody.content["application/json"].schema),
        );
    }
  return {
    request(method, path, value) {
      const validate = requests.get(method.toLowerCase() + " " + path);
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
