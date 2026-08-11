import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { containerAssignSchema, containerCreateSchema, containerListQuerySchema, entityStatusSchema } from '@eco-oil/validation';
import { Roles } from '../auth/decorators/roles.decorator';
import { ContainersService } from './containers.service';

@Controller('containers')
export class ContainersController {
  constructor(@Inject(ContainersService) private readonly service: ContainersService) {}

  @Roles(Role.ADMIN)
  @Post()
  create(@Body() body: unknown) {
    return this.service.create(containerCreateSchema.parse(body));
  }

  @Roles(Role.COLLECTOR, Role.ADMIN)
  @Get('by-qr/:code')
  byQr(@Param('code') code: string) {
    return this.service.byQr(code);
  }

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.service.list(containerListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Patch(':id/assign')
  assign(@Param('id') id: string, @Body() body: unknown) {
    return this.service.assign(id, containerAssignSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateStatus(id, entityStatusSchema.parse(body));
  }
}
