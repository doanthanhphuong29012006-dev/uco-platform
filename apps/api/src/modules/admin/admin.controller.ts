import { Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { adminAlertListQuerySchema, adminOverviewQuerySchema, adminReconciliationQuerySchema } from '@eco-oil/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AccessTokenPayload } from '../auth/auth.types';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly service: AdminService) {}

  @Roles(Role.ADMIN)
  @Get('overview')
  overview(@Query() query: Record<string, unknown>) {
    return this.service.overview(adminOverviewQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Get('reconciliation')
  reconciliation(@Query() query: Record<string, unknown>) {
    return this.service.reconciliation(adminReconciliationQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Get('alerts')
  alerts(@Query() query: Record<string, unknown>) {
    return this.service.listAlerts(adminAlertListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Patch('alerts/:id/resolve')
  resolveAlert(@Param('id') id: string, @CurrentUser() user: AccessTokenPayload) {
    return this.service.resolveAlert(id, user.sub);
  }

  @Roles(Role.ADMIN)
  @Get('merchants/:id/performance')
  merchantPerformance(@Param('id') id: string) {
    return this.service.merchantPerformance(id);
  }
}
