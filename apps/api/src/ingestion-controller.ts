import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UnsupportedMediaTypeException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiTags,
} from "@nestjs/swagger";
import { IdentityService } from "@pdaa/platform";
import {
  ingestionConfigurationSchema,
  ingestionCsvPreviewFormSchema,
  ingestionReviewedImportRequestSchema,
  ingestionReceiptReadSchema,
  IngestionPersistenceError,
  type Actor,
  type IngestionRepository,
} from "@pdaa/domain";

export const INGESTION_REPOSITORY = "INGESTION_REPOSITORY";
const MAX_CSV_BYTES = 1_048_576;
const MAX_MULTIPART_OVERHEAD = 16_384;
const unavailable = async (): Promise<never> => {
  throw new Error("Ingestion repository unavailable");
};
export const unavailableIngestionRepository = {
  listSources: unavailable,
  readSyncSnapshot: unavailable,
  configure: unavailable,
  persistConnectorPage: unavailable,
  persistConnectorEvent: unavailable,
  persistCsvPreview: unavailable,
  commitCsvReviewedImport: unavailable,
  resetSync: unavailable,
  readReceipt: unavailable,
  recordHealth: unavailable,
  setRetention: unavailable,
  purgeExpired: unavailable,
} satisfies IngestionRepository;

type Request = {
  headers: Record<string, string | string[] | undefined>;
  actor?: Actor;
  correlationId: string;
  method: string;
  originalUrl?: string;
};
type UploadedCsv = { buffer: Buffer; size: number; originalname: string };

@Injectable()
export class IngestionIdentityGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length > 16_384)
      throw new HttpException("Sign-in required", 401);
    try {
      request.actor = await this.identity.authenticate(authorization.slice(7));
    } catch {
      throw new HttpException("Session unavailable", 401);
    }
    return true;
  }
}

@Injectable()
class CsvUploadBoundaryGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && (typeof encoding !== "string" || encoding.toLowerCase() !== "identity"))
      throw new UnsupportedMediaTypeException();
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !/^multipart\/form-data\s*;\s*boundary=/i.test(contentType))
      throw new UnsupportedMediaTypeException();
    const length = request.headers["content-length"];
    if (typeof length === "string" && /^\d+$/.test(length) && Number(length) > MAX_CSV_BYTES + MAX_MULTIPART_OVERHEAD)
      throw new PayloadTooLargeException();
    return true;
  }
}

@ApiTags("Spreadsheet ingestion")
@ApiBearerAuth()
@Controller("api/ingestion")
@UseGuards(IngestionIdentityGuard)
export class IngestionController {
  constructor(
    @Inject(INGESTION_REPOSITORY) private readonly ingestion: IngestionRepository,
  ) {}

  private actor(request: Request): Actor {
    if (!request.actor) throw new HttpException("Sign-in required", 401);
    return request.actor;
  }

  private admin(request: Request): Actor {
    const actor = this.actor(request);
    if (!actor.roles.includes("pmo_admin")) throw new ForbiddenException();
    return actor;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof IngestionPersistenceError)) throw error;
      const status: Record<IngestionPersistenceError["code"], number> = {
        DENIED: 404,
        INVALID_REQUEST: 400,
        CONFLICT: 409,
        STALE_CONFIGURATION: 409,
        CURSOR_CONFLICT: 409,
        RETENTION_REQUIRED: 503,
        NOT_FOUND: 404,
        INVALID_PREVIEW: 409,
        INTEGRITY_CONFLICT: 503,
        PERSISTENCE_FAILED: 503,
      };
      throw new HttpException("Ingestion request could not be completed", status[error.code]);
    }
  }

  @Get("sources")
  async sources(@Req() request: Request) {
    const actor = this.admin(request);
    return this.run(() => this.ingestion.listSources(actor));
  }

  @Post("sources/configuration")
  @HttpCode(201)
  async configure(@Req() request: Request, @Body() body: unknown) {
    const actor = this.admin(request);
    const input = ingestionConfigurationSchema.safeParse(body);
    if (!input.success) throw new BadRequestException();
    return this.run(() => this.ingestion.configure(actor, input.data, request.correlationId));
  }

  @Post("sources/:sourceId/csv-previews")
  @HttpCode(201)
  @UseGuards(CsvUploadBoundaryGuard)
  @UseInterceptors(FileInterceptor("file", {
    limits: {
      fileSize: MAX_CSV_BYTES,
      fieldSize: 256,
      fieldNameSize: 64,
      // Multipart values are scalar; nested fields and numeric array indices are not used.
      fieldNestingDepth: 0,
      fieldArrayIndexLimit: 0,
      fields: 3,
      files: 1,
      // Busboy emits partsLimit as soon as the count reaches the configured
      // value, so use 5 to accept the four required file/form parts and reject
      // any fifth part.
      parts: 5,
    },
  }))
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: {
    type: "object",
    required: ["file", "commandKey", "configRevision", "mappingRevision"],
    properties: {
      file: { type: "string", format: "binary" },
      commandKey: { type: "string", maxLength: 128 },
      configRevision: { type: "integer", minimum: 1 },
      mappingRevision: { type: "integer", minimum: 1 },
    },
  } })
  async preview(
    @Req() request: Request,
    @Param("sourceId") sourceId: string,
    @Body() body: unknown,
    @UploadedFile() file?: UploadedCsv,
  ) {
    const actor = this.actor(request);
    const command = ingestionCsvPreviewFormSchema.safeParse(body);
    if (!command.success || !file || file.size < 1 || file.size > MAX_CSV_BYTES || !file.originalname.toLowerCase().endsWith(".csv"))
      throw new BadRequestException();
    let csv: string;
    try {
      csv = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    } catch {
      throw new BadRequestException();
    }
    return this.run(() => this.ingestion.persistCsvPreview(actor, {
      sourceId,
      configRevision: command.data.configRevision,
      mappingRevision: command.data.mappingRevision,
      commandKey: command.data.commandKey,
      fileName: "upload.csv",
      csv,
    }, request.correlationId));
  }

  @Post("sources/:sourceId/reviewed-imports")
  @HttpCode(201)
  async commit(
    @Req() request: Request,
    @Param("sourceId") sourceId: string,
    @Body() body: unknown,
  ) {
    const parsed = ingestionReviewedImportRequestSchema.safeParse({
      ...(body && typeof body === "object" ? body : {}),
      sourceId,
    });
    if (!parsed.success) throw new BadRequestException();
    return this.run(() => this.ingestion.commitCsvReviewedImport(
      this.actor(request), parsed.data, request.correlationId,
    ));
  }

  @Get("sources/:sourceId/receipts/:receiptId")
  async receipt(
    @Req() request: Request,
    @Param("sourceId") sourceId: string,
    @Param("receiptId") receiptId: string,
  ) {
    const parsed = ingestionReceiptReadSchema.safeParse({ sourceId, receiptId });
    if (!parsed.success) throw new BadRequestException();
    return this.run(() => this.ingestion.readReceipt(this.actor(request), parsed.data));
  }
}
