import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { EntityStatus, Role } from '@prisma/client';
import type {
  MerchantListQueryInput,
  MerchantPatchInput,
  MerchantRegisterInput,
  EntityStatusInput,
} from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';

@Injectable()
export class MerchantsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async register(user: AccessTokenPayload, input: MerchantRegisterInput) {
    const existing = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (existing) {
      throw new ConflictException('Merchant profile already exists');
    }
    await this.requireWard(input.ward_id);
    const merchant = await this.prisma.merchant.create({
      data: {
        userId: user.sub,
        wardId: input.ward_id,
        businessName: input.name,
        address: input.address,
        avgDailyLiters: input.avg_daily_liters,
      },
      include: { user: true, ward: true },
    });
    await this.prisma.setGeographyPoint('merchants', merchant.id, input.lat, input.lng);
    return this.findOne(merchant.id);
  }

  async me(user: AccessTokenPayload) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (!merchant) {
      throw new NotFoundException('Merchant profile not found');
    }
    return this.findOne(merchant.id);
  }

  async update(user: AccessTokenPayload, id: string, input: MerchantPatchInput) {
    await this.assertOwnerOrAdmin(user, id);
    await this.getRequired(id);
    if (input.ward_id) {
      await this.requireWard(input.ward_id);
    }
    const merchant = await this.prisma.merchant.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { businessName: input.name } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.ward_id !== undefined ? { wardId: input.ward_id } : {}),
        ...(input.avg_daily_liters !== undefined ? { avgDailyLiters: input.avg_daily_liters } : {}),
      },
    });
    if (input.lat !== undefined && input.lng !== undefined) {
      await this.prisma.setGeographyPoint('merchants', id, input.lat, input.lng);
    }
    return this.findOne(merchant.id);
  }

  async updateStatus(user: AccessTokenPayload, id: string, input: EntityStatusInput) {
    await this.assertOwnerOrAdmin(user, id);
    await this.getRequired(id);
    await this.prisma.merchant.update({
      where: { id },
      data: { status: input.status, isActive: input.status === EntityStatus.ACTIVE, deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null },
    });
    return this.findOne(id);
  }

  async list(query: MerchantListQueryInput) {
    const where: Prisma.MerchantWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status ? { status: query.status } : query.include_inactive ? {} : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.merchant.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { user: true, ward: true },
      }),
      this.prisma.merchant.count({ where }),
    ]);
    const points = await this.prisma.getGeographyPoints('merchants', rows.map((row) => row.id));
    const pointMap = new Map(points.map((point) => [point.id, point]));
    return {
      data: rows.map((row) => this.serialize(row, pointMap.get(row.id))),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async findOne(id: string) {
    const row = await this.getRequired(id);
    const point = await this.prisma.getGeographyPoint('merchants', id);
    return this.serialize(row, point ?? undefined);
  }

  private async assertOwnerOrAdmin(user: AccessTokenPayload, merchantId: string): Promise<void> {
    if (user.role === Role.ADMIN) {
      return;
    }
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { userId: true } });
    if (!merchant || merchant.userId !== user.sub) {
      throw new ForbiddenException('Merchant ownership required');
    }
  }

  private async requireWard(id: string): Promise<void> {
    const ward = await this.prisma.ward.findUnique({ where: { id } });
    if (!ward || ward.deletedAt) {
      throw new NotFoundException('Ward not found');
    }
  }

  private async getRequired(id: string) {
    const row = await this.prisma.merchant.findUnique({ where: { id }, include: { user: true, ward: true } });
    if (!row) {
      throw new NotFoundException('Merchant not found');
    }
    return row;
  }

  private serialize(row: Awaited<ReturnType<MerchantsService['getRequired']>>, point?: { lat: number; lng: number }) {
    return {
      id: row.id,
      user_id: row.userId,
      ward_id: row.wardId,
      name: row.businessName,
      address: row.address,
      avg_daily_liters: row.avgDailyLiters === null ? null : Number(row.avgDailyLiters),
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      status: row.status,
      is_active: row.isActive,
      ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
      user: { id: row.user.id, name: row.user.name, phone: row.user.phone },
    };
  }
}
