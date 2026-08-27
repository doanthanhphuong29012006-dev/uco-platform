import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { adminPersonCreateSchema, adminPersonPatchSchema, entityStatusSchema, personListQuerySchema } from '@eco-oil/validation';
import { Roles } from '../auth/decorators/roles.decorator';
import { CollectorsService } from './collectors.service';

@Controller('collectors')
export class CollectorsController {
  constructor(@Inject(CollectorsService) private readonly service: CollectorsService) {}

  @Roles(Role.ADMIN)
  @Post()
  create(@Body() body: unknown) {
    return this.service.create(adminPersonCreateSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.service.list(personListQuerySchema.parse(query));
  }

  @Roles(Role.ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.service.update(id, adminPersonPatchSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateStatus(id, entityStatusSchema.parse(body));
  }
}
