import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ContainerState, EntityStatus, OrderStatus, OrderSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { OrderListQueryInput, OrderReadyInput, RouteQueryInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';
import { calculatePriority } from './priority';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OrdersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createReady(user: AccessTokenPayload, input: OrderReadyInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant profile not found');
    }

    const container = input.container_id
      ? await this.prisma.container.findUnique({ where: { id: input.container_id } })
      : await this.prisma.container.findFirst({
          where: { merchantId: merchant.id, state: ContainerState.AT_MERCHANT, status: EntityStatus.ACTIVE },
          orderBy: { createdAt: 'asc' },
        });
    if (!container || container.status === EntityStatus.INACTIVE || container.merchantId !== merchant.id || container.state !== ContainerState.AT_MERCHANT) {
      if (!input.container_id || !container) {
        throw new UnprocessableEntityException({
          code: 'NO_CONTAINER_AVAILABLE',
          message: 'No container available for collection',
          details: null,
        });
      }
      throw new ForbiddenException('Container does not belong to merchant');
    }

    const existing = await this.prisma.collectionOrder.findFirst({
      where: { merchantId: merchant.id, containerId: container.id, status: { in: [OrderStatus.READY, OrderStatus.ASSIGNED] }, deletedAt: null },
      orderBy: { requestedAt: 'desc' },
      include: { container: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ORDER_ALREADY_OPEN',
        message: 'An order is already open for this container',
        details: this.serialize(existing),
      });
    }

    const capacityL = Number(container.capacityLiters ?? 0);
    const expectedLiters = input.expected_liters ?? capacityL;
    const daysSinceLastCollection = merchant.lastCollectedAt ? Math.max(0, (Date.now() - merchant.lastCollectedAt.getTime()) / DAY_MS) : 14;
    const priority = calculatePriority({ expectedLiters, capacityL, daysSinceLastCollection });
    const order = await this.prisma.collectionOrder.create({
      data: {
        merchantId: merchant.id,
        containerId: container.id,
        expectedLiters,
        note: input.note,
        priority: Math.round(priority),
        status: OrderStatus.READY,
        source: OrderSource.MANUAL,
      },
      include: { container: true, merchant: true },
    });
    return this.serialize(order);
  }

  async listMine(user: AccessTokenPayload, query: OrderListQueryInput) {
    const merchant = await this.requireMerchant(user.sub);
    const where: Prisma.CollectionOrderWhereInput = {
      merchantId: merchant.id,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.collectionOrder.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { container: true },
      }),
      this.prisma.collectionOrder.count({ where }),
    ]);
    return { data: rows.map((row) => this.serialize(row)), meta: { page: query.page, limit: query.limit, total } };
  }

  async cancel(user: AccessTokenPayload, id: string) {
    const merchant = await this.requireMerchant(user.sub);
    const order = await this.prisma.collectionOrder.findUnique({ where: { id }, include: { container: true } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.merchantId !== merchant.id) {
      throw new ForbiddenException('Order ownership required');
    }
    if (order.status !== OrderStatus.READY) {
      throw new ConflictException('Only READY orders can be cancelled');
    }
    const cancelled = await this.prisma.collectionOrder.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      include: { container: true },
    });
    return this.serialize(cancelled);
  }

  async currentRoute(user: AccessTokenPayload, query: RouteQueryInput) {
    const collector = await this.prisma.collector.findUnique({ where: { userId: user.sub }, include: { ward: true } });
    if (!collector || collector.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Collector profile not found');
    }
    const originLat = query.lat ?? collector.ward.centerLat ?? 0;
    const originLng = query.lng ?? collector.ward.centerLng ?? 0;
    const maxCapacity = Number(collector.maxCapacityLiters);
    const rows = await this.prisma.findReadyOrdersForRoute([collector.wardId], originLat, originLng);
    const stops: Array<{
      seq: number;
      order_id: string;
      merchant: { name: string; address: string | null; lat: number; lng: number };
      container_code: string;
      expected_liters: number;
      priority: number;
      distance_m: number;
    }> = [];
    let total = 0;
    for (const row of rows) {
      if (total + row.expectedLiters > maxCapacity) {
        break;
      }
      total += row.expectedLiters;
      stops.push({
        seq: stops.length + 1,
        order_id: row.orderId,
        merchant: { name: row.merchantName, address: row.merchantAddress, lat: row.merchantLat, lng: row.merchantLng },
        container_code: row.containerCode,
        expected_liters: row.expectedLiters,
        priority: row.priority,
        distance_m: row.distanceM,
      });
    }
    // TODO: persist route/route_stops when re-optimization is introduced in Sprint 4.
    return { stops, total_expected_liters: total, remaining_capacity_l: Math.max(maxCapacity - total, 0) };
  }

  private async requireMerchant(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant profile not found');
    }
    return merchant;
  }

  private serialize(row: {
    id: string;
    merchantId: string;
    containerId: string | null;
    expectedLiters: Prisma.Decimal | null;
    priority: number;
    status: OrderStatus;
    source: OrderSource;
    note?: string | null;
    requestedAt: Date;
    cancelledAt?: Date | null;
    container: { qrCode: string; state: ContainerState; capacityLiters: Prisma.Decimal | null } | null;
  }) {
    return {
      id: row.id,
      merchant_id: row.merchantId,
      container_id: row.containerId,
      container_code: row.container?.qrCode ?? null,
      expected_liters: row.expectedLiters === null ? null : Number(row.expectedLiters),
      priority: Number(row.priority),
      status: row.status,
      source: row.source,
      note: row.note ?? null,
      requested_at: row.requestedAt,
      cancelled_at: row.cancelledAt ?? null,
      container_state: row.container?.state ?? null,
      capacity_l: row.container?.capacityLiters === null || row.container?.capacityLiters === undefined ? null : Number(row.container.capacityLiters),
    };
  }
}
