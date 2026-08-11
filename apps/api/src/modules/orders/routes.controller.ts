import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { routeQuerySchema } from '@eco-oil/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { OrdersService } from './orders.service';

@Controller('routes')
export class RoutesController {
  constructor(@Inject(OrdersService) private readonly service: OrdersService) {}

  @Roles(Role.COLLECTOR)
  @Get('current')
  current(@CurrentUser() user: AccessTokenPayload, @Query() query: Record<string, unknown>) {
    return this.service.currentRoute(user, routeQuerySchema.parse(query));
  }
}
