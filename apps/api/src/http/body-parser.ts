import type { INestApplication } from '@nestjs/common';
import express, { type ErrorRequestHandler } from 'express';

export function createPayloadTooLargeHandler(bodyLimit: string): ErrorRequestHandler {
  return (error, _request, response, next) => {
    const parserError = error as { status?: number; type?: string };
    if (parserError.status === 413 || parserError.type === 'entity.too.large') {
      response.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Dữ liệu gửi lên vượt giới hạn cho phép. Hãy giảm kích thước ảnh hoặc gửi lại.',
        details: { body_limit: bodyLimit },
      });
      return;
    }
    next(error);
  };
}

export function configureBodyParser(app: INestApplication, bodyLimit: string): void {
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));
  app.use(createPayloadTooLargeHandler(bodyLimit));
}
