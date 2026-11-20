import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import type { NestExpressApplication } from "@nestjs/platform-express";
import busboy from "busboy";
import type { IdentityService } from "@pdaa/platform";
import { projectFactIdSchema, xlsxPreviewCommandSchema, type Actor } from "@pdaa/domain";
import { errorMessages } from "./contract.js";
import { xlsxIngestionPath, xlsxIngestionRoutes } from "./xlsx-ingestion-routes.js";

const workbookLimit = 1_048_576;
const bodyLimit = workbookLimit + 16_384;
const fieldLimit = 128;
const fields = new Set(["commandKey", "configRevision", "mappingRevision", "sheet"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const uploadRoute = new RegExp("^/" + xlsxIngestionRoutes.previews.replace(":sourceId", "([^/]+)") + "/?$", "i");
const readRoute = new RegExp("^/(?:" + [
  xlsxIngestionRoutes.sources, xlsxIngestionRoutes.preview, xlsxIngestionRoutes.details,
].map((path) => path.replace(/:[A-Za-z0-9_]+/g, "[^/]+")).join("|") + ")/?$", "i");
const reviewRoute = new RegExp("^/" + xlsxIngestionRoutes.review.replace(":sourceId", "[^/]+") + "/?$", "i");
const roles: Actor["roles"][number][] = ["project_manager", "portfolio_manager", "pmo_admin"];

type Command = ReturnType<typeof xlsxPreviewCommandSchema.parse>;
type UploadInput = { command: Command; workbook: Buffer };
type ClaimedUpload = UploadInput & { signal: AbortSignal; release: () => void };
export type XlsxRequest = IncomingMessage & {
  actor?: Actor;
  correlationId: string;
  claimXlsxUpload?: () => ClaimedUpload;
};
type ErrorStatus = keyof typeof errorMessages;
type JsonResponse = ServerResponse & { status(code: number): JsonResponse; json(value: unknown): void };

class UploadFailure extends Error {
  constructor(readonly status: ErrorStatus) { super("XLSX upload rejected"); }
}

function fail(request: XlsxRequest, response: JsonResponse, status: ErrorStatus) {
  if (response.destroyed || response.writableEnded) return;
  if (!request.complete && request.httpVersionMajor === 1)
    response.setHeader("Connection", "close");
  response.status(status).json({ statusCode: status, message: errorMessages[status] });
}

function decodeSheet(value: string | undefined) {
  // Canonical base64url transports the exact UTF-8 bytes of the configured sheet
  // without relying on a multipart field's optional charset conversion.
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new UploadFailure(400);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new UploadFailure(400);
  try { return utf8.decode(bytes); }
  catch { throw new UploadFailure(400); }
}

function decimal(value: string | undefined) {
  return value && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : undefined;
}

async function readUpload(request: XlsxRequest, sourceId: string, signal: AbortSignal): Promise<UploadInput> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && !/^[0-9]+$/.test(declared)) throw new UploadFailure(400);
  if (declared !== undefined && Number(declared) > bodyLimit) throw new UploadFailure(413);
  const encoding = request.headers["content-encoding"];
  const contentType = request.headers["content-type"];
  if ((encoding !== undefined && encoding !== "identity") ||
    typeof contentType !== "string" || !/^multipart\/form-data\s*;/i.test(contentType))
    throw new UploadFailure(415);

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: workbookLimit + 1, fieldSize: fieldLimit + 1, files: 1, fields: 4, parts: 6 },
    });
  } catch { throw new UploadFailure(400); }

  const values = new Map<string, string>();
  let workbook: Buffer | undefined;
  let bodyBytes = 0;
  let workbookBytes = 0;
  let partFailure: ErrorStatus | undefined;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > bodyLimit) done(new UploadFailure(413));
      else done(null, chunk);
    },
  });
  // A rejected part can still drain through the same deadline and wire cap.
  // This lets the client receive a finite error after an otherwise bounded body.
  const rejectPart = (status: ErrorStatus) => { partFailure ??= status; };
  parser.on("field", (name, value, info) => {
    if (info.valueTruncated || Buffer.byteLength(value) > fieldLimit) { rejectPart(413); return; }
    if (info.nameTruncated || !fields.has(name) || values.has(name)) { rejectPart(400); return; }
    values.set(name, value);
  });
  parser.on("file", (name, stream) => {
    stream.on("error", () => rejectPart(400));
    stream.on("limit", () => rejectPart(413));
    if (name !== "file" || workbook) { stream.resume(); rejectPart(400); return; }
    const buffer = Buffer.alloc(workbookLimit);
    workbook = buffer;
    stream.on("data", (chunk: Buffer) => {
      const end = workbookBytes + chunk.byteLength;
      if (end > workbookLimit) rejectPart(413);
      else if (!partFailure) chunk.copy(buffer, workbookBytes);
      workbookBytes = end;
    });
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
    parser.on(event, () => rejectPart(400));
  const timer = setTimeout(() => counter.destroy(new UploadFailure(400)), 10_000);
  const settled = pipeline(counter, parser, { signal });
  request.pipe(counter);
  try {
    await settled;
  } catch (error) {
    throw error instanceof UploadFailure ? error : new UploadFailure(400);
  } finally {
    clearTimeout(timer);
    request.unpipe(counter);
  }
  if (partFailure !== undefined) throw new UploadFailure(partFailure);
  if (!workbook || !workbookBytes || values.size !== fields.size) throw new UploadFailure(400);
  const command = xlsxPreviewCommandSchema.safeParse({
    sourceId,
    commandKey: values.get("commandKey"),
    configRevision: decimal(values.get("configRevision")),
    mappingRevision: decimal(values.get("mappingRevision")),
    sheet: decodeSheet(values.get("sheet")),
  });
  if (!command.success) throw new UploadFailure(400);
  return { command: command.data, workbook: workbook.subarray(0, workbookBytes) };
}

export function installXlsxIngestionBoundary(
  app: Pick<NestExpressApplication, "use">,
  identity: Pick<IdentityService, "authenticate">,
  enabled: boolean,
) {
  let intakeLeases = 0;
  app.use(xlsxIngestionPath, async (request: XlsxRequest, response: JsonResponse, next: () => void) => {
    if (!enabled) { fail(request, response, 404); return; }
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length > 16_384) {
      fail(request, response, 401); return;
    }
    try { request.actor = await identity.authenticate(authorization.slice(7)); }
    catch { fail(request, response, 401); return; }
    if (!request.actor.roles.some((role) => roles.includes(role))) { fail(request, response, 404); return; }
    if (response.destroyed || (request.destroyed && !request.complete)) return;
    const path = request.url?.split("?", 1)[0] ?? "";
    if ((request.method === "GET" || request.method === "HEAD") && readRoute.test(path)) {
      if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) {
        fail(request, response, 400); return;
      }
      next(); return;
    }
    if (request.method === "POST" && reviewRoute.test(path)) {
      const type = request.headers["content-type"];
      const encoding = request.headers["content-encoding"];
      if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
          (encoding !== undefined && encoding !== "identity")) {
        fail(request, response, 415); return;
      }
      next(); return;
    }
    const upload = request.method === "POST" ? uploadRoute.exec(path) : null;
    if (!upload) { fail(request, response, 404); return; }
    const source = projectFactIdSchema.safeParse(upload[1]);
    if (!source.success || request.url?.includes("?")) { fail(request, response, 400); return; }
    if (intakeLeases >= 2) { fail(request, response, 429); return; }
    intakeLeases++;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    let claimed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      intakeLeases--;
      delete request.claimXlsxUpload;
      request.off("aborted", cancel);
      request.off("error", cancel);
      response.off("finish", finished);
      response.off("close", closed);
    };
    const finished = () => { if (!claimed && request.claimXlsxUpload) release(); };
    const closed = () => {
      if (!response.writableFinished) cancel();
      finished();
    };
    request.once("aborted", cancel);
    request.once("error", cancel);
    response.once("finish", finished);
    response.once("close", closed);
    try {
      const body = await readUpload(request, source.data, abort.signal);
      if (abort.signal.aborted) { release(); return; }
      request.claimXlsxUpload = () => {
        claimed = true;
        delete request.claimXlsxUpload;
        return { ...body, signal: abort.signal, release };
      };
      next();
    } catch (error) {
      release();
      fail(request, response, error instanceof UploadFailure ? error.status : 500);
    }
  });
}
