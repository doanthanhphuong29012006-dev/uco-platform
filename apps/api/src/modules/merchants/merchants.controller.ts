import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  entityStatusSchema,
  merchantListQuerySchema,
  merchantPatchSchema,
  merchantRegisterSchema,
} from '@eco-oil/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { MerchantsService } from './merchants.service';

@Controller('merchants')
export class MerchantsController {
  constructor(@Inject(MerchantsService) private readonly service: MerchantsService) {}

  @Roles(Role.MERCHANT)
  @Post('register')
  register(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.register(user, merchantRegisterSchema.parse(body));
  }

  @Roles(Role.MERCHANT, Role.ADMIN)
  @Get('me/dashboard')
  dashboard(@CurrentUser() user: AccessTokenPayload) {
    return this.service.dashboard(user);
  }

  @Roles(Role.MERCHANT, Role.ADMIN)
  @Get('me')
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.service.me(user);
  }

  @Roles(Role.MERCHANT, Role.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(user, id, merchantPatchSchema.parse(body));
  }

  @Roles(Role.MERCHANT, Role.ADMIN)
  @Patch(':id/status')
  updateStatus(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateStatus(user, id, entityStatusSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.service.list(merchantListQuerySchema.parse(query));
  }
}
