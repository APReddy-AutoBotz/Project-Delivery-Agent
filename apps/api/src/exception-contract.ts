import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
  type HttpServer,
} from "@nestjs/common";
import { errorMessages, isErrorStatus } from "./contract.js";

@Catch()
export class ExceptionContractFilter implements ExceptionFilter {
  constructor(
    private readonly adapter: Pick<
      HttpServer,
      "reply" | "isHeadersSent" | "end"
    >,
  ) {}
  catch(exception: unknown, host: ArgumentsHost) {
    let proposed: unknown;
    if (exception instanceof HttpException) proposed = exception.getStatus();
    else if (
      exception &&
      typeof exception === "object" &&
      "type" in exception
    ) {
      // Only known parser failures may select a client error; arbitrary SDK
      // errors cannot reflect their status, message, body or database details.
      const parserStatuses: Record<string, number> = {
        "entity.too.large": 413,
        "encoding.unsupported": 415,
        "charset.unsupported": 415,
        "entity.parse.failed": 400,
        "request.aborted": 400,
        "request.size.invalid": 400,
      };
      if (typeof exception.type === "string")
        proposed = parserStatuses[exception.type];
    }
    const status = isErrorStatus(proposed) ? proposed : 500;
    const response = host.switchToHttp().getResponse();
    if (this.adapter.isHeadersSent(response)) this.adapter.end(response);
    else
      this.adapter.reply(
        response,
        { statusCode: status, message: errorMessages[status] },
        status,
      );
  }
}
