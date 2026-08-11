import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { EntityStatus, OrderStatus, Role } from '@prisma/client';
import type {
  CollectionListQueryInput,
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

  async dashboard(user: AccessTokenPayload) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant profile not found');
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [containers, pendingOrders, monthlyLiters, latestTransaction, openOrderRows] = await Promise.all([
      this.prisma.container.findMany({
        where: { merchantId: merchant.id, status: EntityStatus.ACTIVE },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.collectionOrder.count({
        where: { merchantId: merchant.id, status: { in: [OrderStatus.READY, OrderStatus.ASSIGNED] }, deletedAt: null },
      }),
      this.prisma.collectionTransaction.aggregate({
        where: { merchantId: merchant.id, collectedAt: { gte: monthStart }, deletedAt: null },
        _sum: { actualLiters: true },
      }),
      this.prisma.collectionTransaction.findFirst({
        where: { merchantId: merchant.id, deletedAt: null },
        orderBy: { collectedAt: 'desc' },
        select: { collectedAt: true },
      }),
      this.prisma.collectionOrder.findMany({
        where: { merchantId: merchant.id, status: { in: [OrderStatus.READY, OrderStatus.ASSIGNED] }, deletedAt: null },
        select: { containerId: true, expectedLiters: true },
      }),
    ]);
    const openOrderByContainer = new Map(openOrderRows.map((order) => [order.containerId, Number(order.expectedLiters ?? 0)]));
    return {
      containers: containers.map((container) => ({
        code: container.qrCode,
        state: container.state,
        capacity_l: container.capacityLiters === null ? null : Number(container.capacityLiters),
        estimated_liters: openOrderByContainer.get(container.id) ?? 0,
      })),
      pending_orders: pendingOrders,
      liters_this_month: monthlyLiters._sum.actualLiters === null ? 0 : Number(monthlyLiters._sum.actualLiters),
      last_collected_at: latestTransaction?.collectedAt ?? merchant.lastCollectedAt,
    };
  }

  async transactions(user: AccessTokenPayload, query: CollectionListQueryInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant profile not found');
    }
    const from = query.from ?? null;
    const to = query.to ?? null;
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ct."id", ct."client_uuid", ct."order_id", ct."container_id",
          ct."merchant_id", ct."collector_id", u."name" AS "collector_name",
          ct."actual_liters"::float8 AS "actual_liters", ct."quality"::text AS "quality",
          ct."photos", ct."collected_at", ct."created_at", c."qr_code" AS "container_code",
          ST_Y(ct."geo_point"::geometry)::float8 AS "geo_lat",
          ST_X(ct."geo_point"::geometry)::float8 AS "geo_lng"
        FROM "collection_transactions" ct
        JOIN "collectors" co ON co."id" = ct."collector_id"
        JOIN "users" u ON u."id" = co."user_id"
        JOIN "containers" c ON c."id" = ct."container_id"
        WHERE ct."merchant_id" = ${merchant.id}::uuid
          AND ct."deleted_at" IS NULL
          AND (${from}::timestamptz IS NULL OR ct."collected_at" >= ${from})
          AND (${to}::timestamptz IS NULL OR ct."collected_at" <= ${to})
        ORDER BY ct."collected_at" DESC
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
      `,
      this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total
        FROM "collection_transactions" ct
        WHERE ct."merchant_id" = ${merchant.id}::uuid
          AND ct."deleted_at" IS NULL
          AND (${from}::timestamptz IS NULL OR ct."collected_at" >= ${from})
          AND (${to}::timestamptz IS NULL OR ct."collected_at" <= ${to})
      `,
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        client_uuid: row.client_uuid,
        order_id: row.order_id,
        container_id: row.container_id,
        container_code: row.container_code,
        merchant_id: row.merchant_id,
        collector_id: row.collector_id,
        collector_name: row.collector_name,
        actual_liters: Number(row.actual_liters),
        quality: row.quality,
        geo: row.geo_lat === null || row.geo_lng === null ? null : { lat: Number(row.geo_lat), lng: Number(row.geo_lng) },
        photos: row.photos,
        collected_at: row.collected_at,
        created_at: row.created_at,
      })),
      meta: { page: query.page, limit: query.limit, total: countRows[0]?.total ?? 0 },
    };
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
