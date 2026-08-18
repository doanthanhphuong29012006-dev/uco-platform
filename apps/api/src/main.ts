import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureBodyParser } from './http/body-parser';

async function bootstrap(): Promise<void> {
  if (Object.prototype.hasOwnProperty.call(process.env, 'JWT_SECRET') && !process.env.JWT_SECRET?.trim()) {
    throw new Error('JWT_SECRET is required and cannot be empty');
  }
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const config = app.get(ConfigService);
  const bodyLimit = config.get<string>('BODY_SIZE_LIMIT')?.trim() || '10mb';
  configureBodyParser(app, bodyLimit);
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Idempotent-Replay'],
  });
  const port = Number(config.get<string>('PORT') ?? '3000');
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
