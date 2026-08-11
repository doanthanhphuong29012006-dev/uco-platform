import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ZodError } from 'zod';
import { collectionCreateSchema } from '@eco-oil/validation';
import { CollectionsService } from '../collections/collections.service';
import type { AccessTokenPayload } from '../auth/auth.types';

@Injectable()
export class SyncService {
  constructor(@Inject(CollectionsService) private readonly collections: CollectionsService) {}

  async processBatch(user: AccessTokenPayload, items: unknown[]) {
    const results: Array<{
      client_uuid: string;
      status: 'created' | 'duplicate' | 'failed';
      id?: string;
      error?: { code: string; message: string };
    }> = [];

    for (const rawItem of items) {
      const clientUuid = this.clientUuidOf(rawItem);
      try {
        const input = collectionCreateSchema.parse(rawItem);
        const result = await this.collections.processOne(user, input, true);
        results.push({ client_uuid: input.client_uuid, status: result.replayed ? 'duplicate' : 'created', id: result.data.id });
      } catch (error) {
        const normalized = this.normalizeError(error);
        results.push({ client_uuid: clientUuid, status: 'failed', error: normalized });
      }
    }

    return {
      results,
      summary: {
        created: results.filter((result) => result.status === 'created').length,
        duplicate: results.filter((result) => result.status === 'duplicate').length,
        failed: results.filter((result) => result.status === 'failed').length,
      },
    };
  }

  private clientUuidOf(item: unknown): string {
    if (typeof item === 'object' && item !== null && 'client_uuid' in item) {
      const value = (item as { client_uuid?: unknown }).client_uuid;
      return typeof value === 'string' ? value : 'unknown';
    }
    return 'unknown';
  }

  private normalizeError(error: unknown): { code: string; message: string } {
    if (error instanceof ZodError) {
      return { code: 'VALIDATION_ERROR', message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    }
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return { code: this.codeForStatus(error.getStatus()), message: response };
      }
      const body = response as Record<string, unknown>;
      return {
        code: typeof body.code === 'string' ? body.code : this.codeForStatus(error.getStatus()),
        message: typeof body.message === 'string' ? body.message : 'Request failed',
      };
    }
    return { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' };
  }

  private codeForStatus(status: number): string {
    return status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 422 ? 'VALIDATION_ERROR' : 'HTTP_ERROR';
  }
}
