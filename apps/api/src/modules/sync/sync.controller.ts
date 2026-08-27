import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { syncBatchSchema } from '@eco-oil/validation';
import { UnprocessableEntityException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(@Inject(SyncService) private readonly service: SyncService) {}

  @Roles(Role.COLLECTOR)
  @HttpCode(HttpStatus.OK)
  @Post('batch')
  batch(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    const input = syncBatchSchema.parse(body);
    if (input.items.length > 100) {
      throw new UnprocessableEntityException({
        code: 'BATCH_TOO_LARGE',
        message: 'A sync batch cannot contain more than 100 items',
        details: { max_items: 100 },
      });
    }
    return this.service.processBatch(user, input.items);
  }
}
