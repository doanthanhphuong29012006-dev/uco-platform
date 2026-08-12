import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { EntityStatus, Role } from '@prisma/client';
import type {
  AdminPersonCreateInput,
  AdminPersonPatchInput,
  EntityStatusInput,
  PersonListQueryInput,
} from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CollectorsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: AdminPersonCreateInput) {
    await this.requireUser(input.user_id, Role.COLLECTOR);
    await this.requireWards(input.ward_ids);
    const existing = await this.prisma.collector.findUnique({ where: { userId: input.user_id } });
    if (existing) {
      throw new ConflictException('Collector profile already exists');
    }
    const row = await this.prisma.collector.create({
      data: { userId: input.user_id, displayName: input.display_name, collectorWards: { create: input.ward_ids.map((wardId) => ({ wardId })) } },
      include: { user: true, collectorWards: { include: { ward: true } } },
    });
    return this.serialize(row);
  }

  async update(id: string, input: AdminPersonPatchInput) {
    await this.getRequired(id);
    if (input.user_id) {
      await this.requireUser(input.user_id, Role.COLLECTOR);
    }
    if (input.ward_ids) {
      await this.requireWards(input.ward_ids);
    }
    const row = await this.prisma.collector.update({
      where: { id },
      data: {
        ...(input.user_id ? { userId: input.user_id } : {}),
        ...(input.display_name ? { displayName: input.display_name } : {}),
      },
      include: { user: true, collectorWards: { include: { ward: true } } },
    });
    if (input.ward_ids) {
      await this.prisma.$transaction(async (tx) => {
        await tx.collectorWard.deleteMany({ where: { collectorId: id } });
        await tx.collectorWard.createMany({ data: input.ward_ids!.map((wardId) => ({ collectorId: id, wardId })) });
      });
    }
    return this.serialize(row);
  }

  async updateStatus(id: string, input: EntityStatusInput) {
    await this.getRequired(id);
    const row = await this.prisma.collector.update({
      where: { id },
      data: { status: input.status, isActive: input.status === EntityStatus.ACTIVE, deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null },
      include: { user: true, collectorWards: { include: { ward: true } } },
    });
    return this.serialize(row);
  }

  async list(query: PersonListQueryInput) {
    const where: Prisma.CollectorWhereInput = {
      ...(query.ward_id ? { collectorWards: { some: { wardId: query.ward_id } } } : {}),
      ...(query.status ? { status: query.status } : query.include_inactive ? {} : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.collector.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { user: true, collectorWards: { include: { ward: true } } },
      }),
      this.prisma.collector.count({ where }),
    ]);
    return { data: rows.map((row) => this.serialize(row)), meta: { page: query.page, limit: query.limit, total } };
  }

  async findOne(id: string) {
    return this.serialize(await this.getRequired(id));
  }

  private async requireUser(id: string, role: Role): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== role || user.deletedAt) {
      throw new NotFoundException(`User with role ${role} not found`);
    }
  }

  private async requireWards(ids: string[]): Promise<void> {
    const wards = await this.prisma.ward.findMany({ where: { id: { in: ids }, deletedAt: null } });
    if (wards.length !== ids.length) {
      throw new NotFoundException('Ward not found');
    }
  }

  private async getRequired(id: string) {
    const row = await this.prisma.collector.findUnique({ where: { id }, include: { user: true, collectorWards: { include: { ward: true } } } });
    if (!row) {
      throw new NotFoundException('Collector not found');
    }
    return row;
  }

  private serialize(row: Awaited<ReturnType<CollectorsService['getRequired']>>) {
    return {
      id: row.id,
      user_id: row.userId,
      display_name: row.displayName,
      status: row.status,
      is_active: row.isActive,
      last_seen_at: row.lastSeenAt,
      wards: row.collectorWards.map((item) => ({ id: item.ward.id, code: item.ward.code, name: item.ward.name })),
      ward_ids: row.collectorWards.map((item) => item.wardId),
      user: { id: row.user.id, name: row.user.name, phone: row.user.phone },
    };
  }
}
