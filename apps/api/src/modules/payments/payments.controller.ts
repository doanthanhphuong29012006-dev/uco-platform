import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  adminPaymentListQuerySchema,
  merchantPaymentListQuerySchema,
  oilPriceCreateSchema,
  paymentRunQuerySchema,
} from '@eco-oil/validation';
import type { AccessTokenPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaymentsService } from './payments.service';

@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(@Inject(PaymentsService) private readonly service: PaymentsService) {}

  @Roles(Role.ADMIN)
  @Post('run')
  run(@Query() query: Record<string, unknown>, @CurrentUser() user: AccessTokenPayload) {
    return this.service.run(paymentRunQuerySchema.parse(query).period, user.sub);
  }

  @Roles(Role.ADMIN)
  @Post(':id/mark-paid')
  markPaid(@Param('id') id: string, @CurrentUser() user: AccessTokenPayload) {
    return this.service.markPaid(id, user.sub);
  }

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.service.listAdmin(adminPaymentListQuerySchema.parse(query));
  }
}

@Controller('admin/oil-prices')
export class AdminOilPricesController {
  constructor(@Inject(PaymentsService) private readonly service: PaymentsService) {}

  @Roles(Role.ADMIN)
  @Get()
  list() {
    return this.service.listOilPrices();
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.createOilPrice(oilPriceCreateSchema.parse(body), user.sub);
  }
}

@Controller('merchants/me/payments')
export class MerchantPaymentsController {
  constructor(@Inject(PaymentsService) private readonly service: PaymentsService) {}

  @Roles(Role.MERCHANT)
  @Get()
  list(@CurrentUser() user: AccessTokenPayload, @Query() query: Record<string, unknown>) {
    return this.service.listMerchant(user, merchantPaymentListQuerySchema.parse(query));
  }
}
