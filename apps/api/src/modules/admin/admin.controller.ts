import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  adminAlertListQuerySchema,
  adminCollectorListQuerySchema,
  adminMerchantListQuerySchema,
  adminOverviewQuerySchema,
  adminReconciliationQuerySchema,
  adminStationListQuerySchema,
  adminCollectorCreateSchema,
  adminCollectorPatchSchema,
  merchantRejectSchema,
  adminContainerCreateSchema,
  adminContainerListQuerySchema,
  adminContainerReturnSchema,
  containerAssignSchema,
  adminWardCreateSchema,
  adminWardPatchSchema,
  adminWardListQuerySchema,
  merchantApprovalSchema,
} from '@eco-oil/validation';
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
  @Get('stations')
  stations(@Query() query: Record<string, unknown>) {
    return this.service.listStations(adminStationListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Get('merchants')
  merchants(@Query() query: Record<string, unknown>) {
    return this.service.listMerchants(adminMerchantListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Post('merchants/:id/approve')
  approveMerchant(@Param('id') id: string, @CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.approveMerchant(id, user.sub, merchantApprovalSchema.parse(body ?? {}));
  }

  @Roles(Role.ADMIN)
  @Post('merchants/:id/reject')
  rejectMerchant(@Param('id') id: string, @CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    return this.service.rejectMerchant(id, user.sub, merchantRejectSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get('containers')
  containers(@Query() query: Record<string, unknown>) {
    return this.service.listContainers(adminContainerListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Get('wards')
  wards(@Query() query: Record<string, unknown>) {
    return this.service.listWards(adminWardListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Post('wards')
  createWard(@Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.createWard(adminWardCreateSchema.parse(body), user.sub);
  }

  @Roles(Role.ADMIN)
  @Patch('wards/:id')
  updateWard(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.updateWard(id, adminWardPatchSchema.parse(body), user.sub);
  }

  @Roles(Role.ADMIN)
  @Get('containers/:id')
  container(@Param('id') id: string) {
    return this.service.getContainer(id);
  }

  @Roles(Role.ADMIN)
  @Post('containers')
  createContainer(@Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.createContainer(adminContainerCreateSchema.parse(body), user.sub);
  }

  @Roles(Role.ADMIN)
  @Post('containers/:id/assign')
  assignContainer(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.assignContainer(id, containerAssignSchema.parse(body), user.sub);
  }

  @Roles(Role.ADMIN)
  @Post('containers/:id/unassign')
  unassignContainer(@Param('id') id: string, @CurrentUser() user: AccessTokenPayload) {
    return this.service.unassignContainer(id, user.sub);
  }

  @Roles(Role.ADMIN)
  @Post('containers/:id/return-to-merchant')
  returnContainerToMerchant(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AccessTokenPayload) {
    return this.service.returnContainerToMerchant(id, adminContainerReturnSchema.parse(body ?? {}), user.sub);
  }

  @Roles(Role.ADMIN)
  @Get('collectors')
  collectors(@Query() query: Record<string, unknown>) {
    return this.service.listCollectors(adminCollectorListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Post('collectors')
  createCollector(@Body() body: unknown) {
    return this.service.createCollector(adminCollectorCreateSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Patch('collectors/:id')
  updateCollector(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCollector(id, adminCollectorPatchSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get('collectors/:id/performance')
  collectorPerformance(@Param('id') id: string) {
    return this.service.collectorPerformance(id);
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
