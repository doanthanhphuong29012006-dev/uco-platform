import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { routeCancelSchema, routeQuerySchema, routeStartSchema } from '@eco-oil/validation';
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

  @Roles(Role.COLLECTOR)
  @Post('start')
  start(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.startRoute(user, routeStartSchema.parse(body));
  }

  @Roles(Role.COLLECTOR)
  @Post('current/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AccessTokenPayload) {
    return this.service.completeRoute(user);
  }

  @Roles(Role.COLLECTOR)
  @Post('current/cancel')
  cancel(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.cancelRoute(user, routeCancelSchema.parse(body));
  }
}
