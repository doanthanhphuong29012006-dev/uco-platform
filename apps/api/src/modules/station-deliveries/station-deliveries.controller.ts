import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { stationDeliveryCreateSchema } from '@eco-oil/validation';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { StationDeliveriesService } from './station-deliveries.service';

@Controller('station-deliveries')
export class StationDeliveriesController {
  constructor(@Inject(StationDeliveriesService) private readonly service: StationDeliveriesService) {}

  @Roles(Role.COLLECTOR)
  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.create(user, stationDeliveryCreateSchema.parse(body));
    if (result.replayed) {
      response.status(200).setHeader('X-Idempotent-Replay', 'true');
    }
    return result.data;
  }
}
