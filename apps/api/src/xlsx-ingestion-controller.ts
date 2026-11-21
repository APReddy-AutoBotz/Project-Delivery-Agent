import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject,
  Param, Post, Query, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  IngestionPersistenceError, ingestionReviewedImportResultSchema, projectFactIdSchema,
  xlsxCatalogueInputSchema, xlsxCataloguePageSchema, xlsxPreviewCommandSchema,
  xlsxPreviewPageInputSchema, xlsxPreviewPageSchema, xlsxPreviewReviewDetailsInputSchema,
  xlsxPreviewReviewDetailsSchema, xlsxReviewedImportRequestSchema, type Actor,
} from "@pdaa/domain";
import { z } from "zod";
import type { XlsxRequest } from "./xlsx-ingestion-boundary.js";
import { xlsxIngestionPath, xlsxIngestionRoutes } from "./xlsx-ingestion-routes.js";

export interface XlsxApplicationRepository {
  listXlsxSources(
    actor: Actor, input: z.infer<typeof xlsxCatalogueInputSchema>,
  ): Promise<z.infer<typeof xlsxCataloguePageSchema>>;
  persistXlsxPreview(
    actor: Actor, command: z.infer<typeof xlsxPreviewCommandSchema>, workbook: Buffer,
    correlationId: string, signal?: AbortSignal,
  ): Promise<{ receiptId: string; replayed: boolean; rowCount: number }>;
  readXlsxPreviewReceipt(
    actor: Actor, input: z.infer<typeof xlsxPreviewPageInputSchema>,
  ): Promise<z.infer<typeof xlsxPreviewPageSchema>>;
  readXlsxPreviewReviewDetails(
    actor: Actor, input: z.infer<typeof xlsxPreviewReviewDetailsInputSchema>,
  ): Promise<z.infer<typeof xlsxPreviewReviewDetailsSchema>>;
  commitXlsxReviewedImport(
    actor: Actor, input: z.infer<typeof xlsxReviewedImportRequestSchema>, correlationId: string,
  ): Promise<z.infer<typeof ingestionReviewedImportResultSchema>>;
}

export const XLSX_APPLICATION_REPOSITORY = Symbol("XLSX_APPLICATION_REPOSITORY");

const errors: Record<IngestionPersistenceError["code"], number> = {
  DENIED: 404, INVALID_REQUEST: 400, CONFLICT: 409, STALE_CONFIGURATION: 409,
  CURSOR_CONFLICT: 409, RETENTION_REQUIRED: 503, NOT_FOUND: 404, INVALID_PREVIEW: 409,
  INTEGRITY_CONFLICT: 503, PERSISTENCE_FAILED: 503,
};
const catalogueQuery = z.strictObject({ afterSourceId: projectFactIdSchema.optional() });
const previewQuery = z.strictObject({ afterOrdinal: z.string().regex(/^(?:0|[1-9][0-9]{0,3})$/).optional() });
const reviewBody = xlsxReviewedImportRequestSchema.omit({ sourceId: true });
const noQuery = z.strictObject({});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException();
  return result.data;
}

@ApiTags("Spreadsheet ingestion")
@ApiBearerAuth()
@Controller(xlsxIngestionPath)
export class XlsxIngestionController {
  constructor(
    @Inject(XLSX_APPLICATION_REPOSITORY) private readonly repository: XlsxApplicationRepository | null,
  ) {}

  private async run<T>(request: XlsxRequest, operation: (
    repository: XlsxApplicationRepository, actor: NonNullable<XlsxRequest["actor"]>,
  ) => Promise<T>): Promise<T> {
    if (!this.repository) throw new HttpException("Resource unavailable", 404);
    if (!request.actor) throw new HttpException("Sign-in required", 401);
    try { return await operation(this.repository, request.actor); }
    catch (error) {
      if (!(error instanceof IngestionPersistenceError)) throw error;
      throw new HttpException("Ingestion request could not be completed", errors[error.code]);
    }
  }

  @Get(xlsxIngestionRoutes.sources)
  sources(@Req() request: XlsxRequest, @Query() query: unknown) {
    return this.run(request, (repository, actor) => repository.listXlsxSources(actor, {
      afterSourceId: parse(catalogueQuery, query).afterSourceId ?? null,
    }));
  }

  @Post(xlsxIngestionRoutes.previews)
  @HttpCode(201)
  async submitPreview(@Req() request: XlsxRequest) {
    const upload = request.claimXlsxUpload?.();
    if (!upload) throw new BadRequestException();
    try {
      return await this.run(request, (repository, actor) => repository.persistXlsxPreview(
        actor, upload.command, upload.workbook, request.correlationId, upload.signal,
      ));
    } finally { upload.release(); }
  }

  @Get(xlsxIngestionRoutes.preview)
  preview(@Req() request: XlsxRequest, @Param() params: object, @Query() query: unknown) {
    return this.run(request, (repository, actor) => repository.readXlsxPreviewReceipt(actor, parse(
      xlsxPreviewPageInputSchema, {
        ...params, afterOrdinal: Number(parse(previewQuery, query).afterOrdinal ?? 0),
      },
    )));
  }

  @Get(xlsxIngestionRoutes.details)
  details(@Req() request: XlsxRequest, @Param() params: unknown, @Query() query: unknown) {
    return this.run(request, (repository, actor) => {
      parse(noQuery, query);
      return repository.readXlsxPreviewReviewDetails(actor, parse(xlsxPreviewReviewDetailsInputSchema, params));
    });
  }

  @Post(xlsxIngestionRoutes.review)
  @HttpCode(201)
  review(@Req() request: XlsxRequest, @Param("sourceId") sourceId: string, @Query() query: unknown, @Body() body: unknown) {
    return this.run(request, (repository, actor) => {
      parse(noQuery, query);
      const input = parse(xlsxReviewedImportRequestSchema, { ...parse(reviewBody, body), sourceId });
      return repository.commitXlsxReviewedImport(actor, input, request.correlationId);
    });
  }
}
