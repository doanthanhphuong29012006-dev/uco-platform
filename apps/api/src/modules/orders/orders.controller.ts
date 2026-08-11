import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { orderListQuerySchema, orderReadySchema } from '@eco-oil/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly service: OrdersService) {}

  @Roles(Role.MERCHANT)
  @Post('ready')
  createReady(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.createReady(user, orderReadySchema.parse(body));
  }

  @Roles(Role.MERCHANT)
  @Get('me')
  listMine(@CurrentUser() user: AccessTokenPayload, @Query() query: Record<string, unknown>) {
    return this.service.listMine(user, orderListQuerySchema.parse(query));
  }

  @Roles(Role.MERCHANT)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string) {
    return this.service.cancel(user, id);
  }

}
