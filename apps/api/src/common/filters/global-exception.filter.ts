import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

type ErrorBody = {
  code: string;
  message: string;
  details: unknown;
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException && exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception.stack ?? exception.message);
    } else if (exception instanceof Error && !(exception instanceof ZodError)) {
      this.logger.error(exception.stack ?? exception.message);
    }
    const error = this.normalize(exception);
    const status = this.statusFor(exception);
    response.status(status).json(error);
  }

  private normalize(exception: unknown): ErrorBody {
    if (exception instanceof ZodError) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: exception.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return {
          code: this.codeForStatus(exception.getStatus()),
          message: body,
          details: null,
        };
      }

      const objectBody = body as Record<string, unknown>;
      return {
        code: typeof objectBody.code === 'string' ? objectBody.code : this.codeForStatus(exception.getStatus()),
        message:
          typeof objectBody.message === 'string'
            ? objectBody.message
            : this.defaultMessage(exception.getStatus()),
        details: objectBody.details ?? null,
      };
    }

    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      details: null,
    };
  }

  private statusFor(exception: unknown): number {
    if (exception instanceof ZodError) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';
      default:
        return status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR';
    }
  }

  private defaultMessage(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return 'Unauthorized';
      case HttpStatus.FORBIDDEN:
        return 'Forbidden';
      default:
        return 'Request failed';
    }
  }
}
