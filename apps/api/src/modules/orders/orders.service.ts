import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AlertSeverity, AlertType, ContainerState, EntityStatus, MerchantApprovalStatus, OrderStatus, OrderSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { OrderListQueryInput, OrderReadyInput, RouteQueryInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';
import { optimizeCollectionRoute } from './collection-route-optimizer';
import { scoreMerchantPickupPriority } from './merchant-pickup-priority';
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
    if (merchant.approvalStatus !== MerchantApprovalStatus.APPROVED) {
      throw new ForbiddenException({
        code: 'MERCHANT_NOT_APPROVED',
        message: 'Tài khoản quán chưa được duyệt',
        details: { approval_status: merchant.approvalStatus },
      });
    }

    const assignedContainerCount = await this.prisma.container.count({
      where: { merchantId: merchant.id, status: EntityStatus.ACTIVE },
    });
    const container = input.container_id
      ? await this.prisma.container.findUnique({ where: { id: input.container_id } })
      : await this.prisma.container.findFirst({
          where: { merchantId: merchant.id, state: ContainerState.AT_MERCHANT, status: EntityStatus.ACTIVE },
          orderBy: { createdAt: 'asc' },
        });
    if (!container || container.status === EntityStatus.INACTIVE || container.merchantId !== merchant.id || container.state !== ContainerState.AT_MERCHANT) {
      if (!input.container_id || !container) {
        throw new UnprocessableEntityException({
          code: assignedContainerCount === 0 ? 'NO_CONTAINER_ASSIGNED' : 'NO_CONTAINER_AVAILABLE',
          message: assignedContainerCount === 0 ? 'No container has been assigned to this merchant' : 'No container available for collection',
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
    if (expectedLiters <= 0 || expectedLiters > capacityL) {
      throw new BadRequestException({
        code: 'EXPECTED_LITERS_EXCEEDS_CAPACITY',
        message: `Số lít dự kiến phải lớn hơn 0 và không vượt quá dung tích can ${capacityL} lít`,
        details: { capacity_l: capacityL, expected_liters: expectedLiters },
      });
    }
    const daysSinceLastCollection = merchant.lastCollectedAt ? Math.max(0, (Date.now() - merchant.lastCollectedAt.getTime()) / DAY_MS) : 14;
    const priority = calculatePriority({ expectedLiters, capacityL, daysSinceLastCollection });
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.collectionOrder.create({
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
      const collector = await tx.collectorWard.findFirst({
        where: {
          wardId: merchant.wardId,
          collector: { status: EntityStatus.ACTIVE, isActive: true, deletedAt: null },
        },
        select: { collectorId: true },
      });
      if (!collector) {
        await tx.alert.create({
          data: {
            type: AlertType.NO_COLLECTOR_IN_WARD,
            severity: AlertSeverity.HIGH,
            message: 'Đơn đã ghi nhận nhưng khu vực chưa có người thu gom phụ trách',
            details: { order_id: order.id, merchant_id: merchant.id, ward_id: merchant.wardId },
          },
        });
      }
      return { order, collectorAvailable: Boolean(collector) };
    });
    return { ...this.serialize(result.order), collector_available: result.collectorAvailable };
  }

  async listMine(user: AccessTokenPayload, query: OrderListQueryInput) {
    const merchant = await this.requireMerchant(user.sub);
    this.ensureApproved(merchant.approvalStatus);
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
    this.ensureApproved(merchant.approvalStatus);
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
    const collector = await this.prisma.collector.findUnique({
      where: { userId: user.sub },
      include: { collectorWards: { include: { ward: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!collector || collector.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Collector profile not found');
    }
    const originWard = collector.collectorWards[0]?.ward;
    const originLat = query.lat ?? originWard?.centerLat ?? 0;
    const originLng = query.lng ?? originWard?.centerLng ?? 0;
    const maxCapacity = Number(collector.maxCapacityLiters);
    const wardIds = collector.collectorWards.map((item) => item.wardId);
    const rows = await this.prisma.findReadyOrdersForRoute(wardIds, originLat, originLng);
    const now = Date.now();
    const scoredRows = rows
      .map((row, index) => {
        const daysSinceLastCollection = row.lastCollectedAt
          ? Math.max(0, (now - row.lastCollectedAt.getTime()) / DAY_MS)
          : null;
        const pickupPriority = scoreMerchantPickupPriority({
          estimated_liters: row.expectedLiters,
          container_capacity_liters: row.containerCapacityLiters,
          days_since_last_collection: daysSinceLastCollection,
          distance_km: row.distanceM / 1000,
          has_active_pickup: false,
        });
        return { row, index, pickupPriority };
      })
      .sort((left, right) =>
        right.pickupPriority.score - left.pickupPriority.score ||
        right.row.priority - left.row.priority ||
        left.row.distanceM - right.row.distanceM ||
        left.index - right.index,
      );
    const stops: Array<{
      seq: number;
      order_id: string;
      merchant: { name: string; address: string | null; phone?: string | null; lat: number; lng: number };
      container_code: string;
      expected_liters: number;
        priority: number;
        distance_m: number;
        ward_center: { lat: number; lng: number } | null;
      pickup_priority_score: number;
      pickup_priority_level: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW' | 'INSUFFICIENT_DATA';
      pickup_priority_reason_codes: string[];
    }> = [];
    let total = 0;
    for (const scoredRow of scoredRows) {
      const { row, pickupPriority } = scoredRow;
      if (total + row.expectedLiters > maxCapacity) {
        break;
      }
      total += row.expectedLiters;
      stops.push({
        seq: stops.length + 1,
        order_id: row.orderId,
        merchant: { name: row.merchantName, address: row.merchantAddress, phone: row.merchantPhone, lat: row.merchantLat, lng: row.merchantLng },
        container_code: row.containerCode,
        expected_liters: row.expectedLiters,
        priority: row.priority,
        distance_m: row.distanceM,
        ward_center: row.wardCenterLat === null || row.wardCenterLng === null ? null : { lat: row.wardCenterLat, lng: row.wardCenterLng },
        pickup_priority_score: pickupPriority.score,
        pickup_priority_level: pickupPriority.priority,
        pickup_priority_reason_codes: pickupPriority.reason_codes,
      });
    }
    let orderedStops = stops;
    let routeOptimization: {
      estimated_distance_before_m: number | null;
      estimated_distance_after_m: number | null;
      saved_distance_m: number | null;
      optimization_applied: boolean;
      reason_codes: Array<'ROUTE_OPTIMIZED' | 'ALREADY_OPTIMAL' | 'INSUFFICIENT_STOPS' | 'INVALID_ORIGIN' | 'INVALID_STOP_COORDINATES'>;
    };
    try {
      const optimization = optimizeCollectionRoute({
        origin: { lat: originLat, lng: originLng },
        stops: stops.map((stop, index) => ({
          id: stop.order_id,
          lat: stop.merchant.lat,
          lng: stop.merchant.lng,
          pickup_priority_score: stop.pickup_priority_score,
          legacy_priority: stop.priority,
          original_index: index,
        })),
      });
      const stopsById = new Map(stops.map((stop) => [stop.order_id, stop]));
      orderedStops = optimization.stops.map((optimizedStop, index) => {
        const originalStop = stopsById.get(optimizedStop.id);
        if (!originalStop) {
          throw new Error('Route optimizer returned an unknown order');
        }
        return { ...originalStop, seq: index + 1 };
      });
      routeOptimization = {
        estimated_distance_before_m: optimization.estimated_distance_before_m,
        estimated_distance_after_m: optimization.estimated_distance_after_m,
        saved_distance_m: optimization.saved_distance_m,
        optimization_applied: optimization.optimization_applied,
        reason_codes: optimization.reason_codes,
      };
    } catch {
      orderedStops = stops.map((stop, index) => ({ ...stop, seq: index + 1 }));
      routeOptimization = {
        estimated_distance_before_m: null,
        estimated_distance_after_m: null,
        saved_distance_m: null,
        optimization_applied: false,
        reason_codes: ['INVALID_STOP_COORDINATES'],
      };
    }
    // TODO(sprint-4): Persist optimized route/route_stops when route persistence is introduced.
    return { stops: orderedStops, total_expected_liters: total, remaining_capacity_l: Math.max(maxCapacity - total, 0), route_optimization: routeOptimization };
  }

  private async requireMerchant(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant profile not found');
    }
    return merchant;
  }

  private ensureApproved(status: MerchantApprovalStatus): void {
    if (status !== MerchantApprovalStatus.APPROVED) {
      throw new ForbiddenException({
        code: 'MERCHANT_NOT_APPROVED',
        message: 'Tài khoản quán chưa được duyệt',
        details: { approval_status: status },
      });
    }
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
