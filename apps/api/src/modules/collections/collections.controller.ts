import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { collectionCreateSchema, collectionListQuerySchema } from '@eco-oil/validation';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { CollectionsService } from './collections.service';

@Controller('collections')
export class CollectionsController {
  constructor(@Inject(CollectionsService) private readonly service: CollectionsService) {}

  @Roles(Role.COLLECTOR)
  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.create(user, collectionCreateSchema.parse(body));
    if (result.replayed) {
      response.status(200).setHeader('X-Idempotent-Replay', 'true');
    }
    return result.data;
  }

  @Roles(Role.COLLECTOR)
  @Get('me')
  listMine(@CurrentUser() user: AccessTokenPayload, @Query() query: Record<string, unknown>) {
    return this.service.listMine(user, collectionListQuerySchema.parse(query));
  }
}
