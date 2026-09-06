import {
  InternalServerErrorException,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from "@nestjs/common";
import { map } from "rxjs";
import { contracts } from "./contract.js";

export class ResponseContractInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; route: { path: string } }>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number }>();
    const path = request.route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    // Express automatically serves HEAD through GET and strips the wire body.
    const method =
      request.method === "HEAD" ? "get" : request.method.toLowerCase();
    const contract = contracts[`${method} ${path}`];
    return next.handle().pipe(
      map((value: unknown) => {
        if (!contract || response.statusCode !== contract.status)
          throw new InternalServerErrorException();
        if (!contract.response) {
          if (value !== undefined) throw new InternalServerErrorException();
          return undefined;
        }
        const result = contract.response.safeParse(value);
        // Never emit validation issues or the malformed (potentially sensitive) data.
        if (!result.success) throw new InternalServerErrorException();
        return result.data;
      }),
    );
  }
}
