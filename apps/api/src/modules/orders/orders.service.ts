import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AlertSeverity, AlertType, ContainerState, EntityStatus, MerchantApprovalStatus, OrderStatus, OrderSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { CurrentRouteResponse } from '@eco-oil/shared-types';
import type { OrderListQueryInput, OrderReadyInput, RouteCancelInput, RouteQueryInput, RouteStartInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';
import { optimizeCollectionRoute } from './collection-route-optimizer';
import { assessCollectorRouteCapacityRisk } from './collector-route-capacity-risk';
import { scoreMerchantPickupPriority } from './merchant-pickup-priority';
import { forecastMerchantPickupVolume } from './merchant-pickup-volume-forecast';
import { calculatePriority } from './priority';

const DAY_MS = 24 * 60 * 60 * 1000;

type RouteCollector = {
  id: string;
  maxCapacityLiters: Prisma.Decimal | number;
  status: EntityStatus;
  collectorWards: Array<{
    wardId: string;
    createdAt: Date;
    ward: { centerLat: number | null; centerLng: number | null };
  }>;
};

type PersistedRoute = {
  id: string;
  clientUuid: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  originLat: number | null;
  originLng: number | null;
  vehicleCapacityLiters: Prisma.Decimal;
  totalExpectedLiters: Prisma.Decimal;
  remainingCapacityLiters: Prisma.Decimal;
  optimizationSnapshot: Prisma.JsonValue;
  capacityRiskSnapshot: Prisma.JsonValue;
  startedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  stops: Array<{
    orderId: string;
    sequence: number;
    expectedLiters: Prisma.Decimal | null;
    merchantSnapshot: Prisma.JsonValue;
    aiSnapshot: Prisma.JsonValue;
    status: 'PENDING' | 'COLLECTED' | 'SKIPPED';
    collectedAt: Date | null;
    skippedAt: Date | null;
    skipReason: string | null;
  }>;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

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

  async currentRoute(user: AccessTokenPayload, query: RouteQueryInput): Promise<CurrentRouteResponse> {
    const collector = await this.requireRouteCollector(user);
    const activeRoute = await this.prisma.collectionRoute.findFirst({
      where: { collectorId: collector.id, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    const response = activeRoute
      ? await this.serializePersistedRoute(activeRoute as unknown as PersistedRoute)
      : await this.buildRoutePreview(collector, query);
    const statusCounts = response.stops.reduce<Record<string, number>>((counts, stop) => {
      const status = stop.route_stop_status ?? 'READY';
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    this.logger.log({
      event: 'collector_route_loaded',
      user_id: user.sub,
      collector_id: collector.id,
      route_id: response.route_id,
      route_status: response.route_status,
      order_statuses: statusCounts,
    });
    return response;
  }

  async startRoute(user: AccessTokenPayload, input: RouteStartInput): Promise<CurrentRouteResponse> {
    const collector = await this.requireRouteCollector(user);
    const existingByClient = await this.prisma.collectionRoute.findUnique({
      where: { clientUuid: input.client_uuid },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (existingByClient) {
      if (existingByClient.status === 'CANCELLED') {
        throw new ConflictException({ code: 'ROUTE_CLIENT_UUID_CANCELLED', message: 'Client UUID đã được dùng cho một ca đã hủy', details: null });
      }
      return this.serializePersistedRoute(existingByClient as unknown as PersistedRoute);
    }

    const activeRoute = await this.prisma.collectionRoute.findFirst({
      where: { collectorId: collector.id, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (activeRoute) {
      return this.serializePersistedRoute(activeRoute as unknown as PersistedRoute);
    }

    const preview = await this.buildRoutePreview(collector, { lat: input.lat, lng: input.lng });
    if (preview.stops.length === 0) {
      throw new ConflictException({ code: 'NO_READY_ORDERS', message: 'Hiện chưa có đơn READY để bắt đầu ca', details: null });
    }
    const originWard = collector.collectorWards[0]?.ward;
    const originLat = input.lat ?? originWard?.centerLat ?? 0;
    const originLng = input.lng ?? originWard?.centerLng ?? 0;
    const orderIds = preview.stops.map((stop) => stop.order_id);

    try {
      const route = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.collectionOrder.updateMany({
          where: { id: { in: orderIds }, status: OrderStatus.READY, collectorId: null, deletedAt: null },
          data: { status: OrderStatus.ASSIGNED, collectorId: collector.id, assignedAt: new Date() },
        });
        if (claimed.count !== orderIds.length) {
          throw new ConflictException({ code: 'ROUTE_CHANGED', message: 'Tuyến đã thay đổi, vui lòng tải lại trước khi bắt đầu ca', details: null });
        }
        return tx.collectionRoute.create({
          data: {
            clientUuid: input.client_uuid,
            collectorId: collector.id,
            status: 'ACTIVE',
            originLat,
            originLng,
            vehicleCapacityLiters: Number(collector.maxCapacityLiters),
            totalExpectedLiters: preview.total_expected_liters,
            remainingCapacityLiters: preview.remaining_capacity_l,
            optimizationSnapshot: preview.route_optimization as Prisma.InputJsonValue,
            capacityRiskSnapshot: preview.route_capacity_risk as Prisma.InputJsonValue,
            stops: {
              create: preview.stops.map((stop) => ({
                orderId: stop.order_id,
                sequence: stop.seq,
                expectedLiters: stop.expected_liters,
                merchantSnapshot: {
                  name: stop.merchant.name,
                  address: stop.merchant.address,
                  phone: stop.merchant.phone ?? null,
                  lat: stop.merchant.lat,
                  lng: stop.merchant.lng,
                  container_code: stop.container_code,
                  distance_m: stop.distance_m,
                  ward_center: stop.ward_center ?? null,
                } as Prisma.InputJsonValue,
                aiSnapshot: {
                  priority: stop.priority,
                  pickup_priority_score: stop.pickup_priority_score,
                  pickup_priority_level: stop.pickup_priority_level,
                  pickup_priority_reason_codes: stop.pickup_priority_reason_codes,
                  pickup_volume_forecast: stop.pickup_volume_forecast,
                } as Prisma.InputJsonValue,
              })),
            },
          },
          include: { stops: { orderBy: { sequence: 'asc' } } },
        });
      });
      return this.serializePersistedRoute(route as unknown as PersistedRoute);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException({ code: 'ROUTE_ALREADY_ACTIVE', message: 'Collector đã có một ca đang hoạt động', details: null });
    }
  }

  async completeRoute(user: AccessTokenPayload): Promise<CurrentRouteResponse> {
    const collector = await this.requireRouteCollector(user);
    const activeRoute = await this.prisma.collectionRoute.findFirst({
      where: { collectorId: collector.id, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (!activeRoute) {
      const completedRoute = await this.prisma.collectionRoute.findFirst({
        where: { collectorId: collector.id, status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        include: { stops: { orderBy: { sequence: 'asc' } } },
      });
      if (completedRoute) return this.serializePersistedRoute(completedRoute as unknown as PersistedRoute);
      throw new NotFoundException('Không có ca đang hoạt động');
    }
    const pending = activeRoute.stops.filter((stop) => stop.status === 'PENDING');
    if (pending.length > 0) {
      throw new ConflictException({ code: 'ROUTE_STOPS_PENDING', message: 'Chưa thể kết ca khi vẫn còn điểm chưa thu hoặc bỏ qua', details: { pending: pending.length } });
    }
    const completedRoute = await this.prisma.$transaction(async (tx) => {
      await tx.collectionRoute.update({ where: { id: activeRoute.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return tx.collectionRoute.findUnique({ where: { id: activeRoute.id }, include: { stops: { orderBy: { sequence: 'asc' } } } });
    });
    if (!completedRoute) throw new NotFoundException('Không tìm thấy ca sau khi kết thúc');
    return this.serializePersistedRoute(completedRoute as unknown as PersistedRoute);
  }

  async cancelRoute(user: AccessTokenPayload, input: RouteCancelInput): Promise<{ route_id: string; status: 'CANCELLED' }> {
    const collector = await this.requireRouteCollector(user);
    const activeRoute = await this.prisma.collectionRoute.findFirst({
      where: { collectorId: collector.id, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (!activeRoute) {
      const cancelledRoute = await this.prisma.collectionRoute.findFirst({
        where: { collectorId: collector.id, status: 'CANCELLED' },
        orderBy: { cancelledAt: 'desc' },
      });
      if (cancelledRoute) return { route_id: cancelledRoute.id, status: 'CANCELLED' };
      throw new NotFoundException('Không có ca đang hoạt động');
    }
    if (activeRoute.stops.some((stop) => stop.status === 'COLLECTED')) {
      throw new ConflictException({ code: 'ROUTE_HAS_COLLECTED_STOPS', message: 'Không thể hủy ca sau khi đã thu ít nhất một điểm', details: null });
    }
    const cancelledAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.collectionOrder.updateMany({
        where: { id: { in: activeRoute.stops.map((stop) => stop.orderId) }, collectorId: collector.id, status: OrderStatus.ASSIGNED },
        data: { status: OrderStatus.READY, collectorId: null, assignedAt: null },
      });
      await tx.collectionRouteStop.updateMany({
        where: { routeId: activeRoute.id, status: 'PENDING' },
        data: { status: 'SKIPPED', skippedAt: cancelledAt, skipReason: input.reason ?? 'Ca bị hủy' },
      });
      await tx.collectionRoute.update({ where: { id: activeRoute.id }, data: { status: 'CANCELLED', cancelledAt } });
    });
    return { route_id: activeRoute.id, status: 'CANCELLED' };
  }

  private async requireRouteCollector(user: AccessTokenPayload): Promise<RouteCollector> {
    const collector = await this.prisma.collector.findUnique({
      where: { userId: user.sub },
      include: { collectorWards: { include: { ward: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!collector || collector.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Collector profile not found');
    }
    return collector as unknown as RouteCollector;
  }

  private async buildRoutePreview(collector: RouteCollector, query: RouteQueryInput): Promise<CurrentRouteResponse> {
    const originWard = collector.collectorWards[0]?.ward;
    const originLat = query.lat ?? originWard?.centerLat ?? 0;
    const originLng = query.lng ?? originWard?.centerLng ?? 0;
    const maxCapacity = Number(collector.maxCapacityLiters);
    const wardIds = collector.collectorWards.map((item) => item.wardId);
    const rows = await this.prisma.findReadyOrdersForRoute(wardIds, originLat, originLng);
    const asOf = new Date();
    const now = asOf.getTime();
    const merchantIds = [...new Set(rows.map((row) => row.merchantId))];
    const historyRows = rows.length === 0
      ? []
      : await this.prisma.findRecentCollectionHistoryByMerchantIds(merchantIds);
    const historyByMerchant = new Map<string, Array<{ actual_liters: number; collected_at: Date }>>();
    for (const historyRow of historyRows) {
      const merchantHistory = historyByMerchant.get(historyRow.merchantId) ?? [];
      merchantHistory.push({ actual_liters: historyRow.actualLiters, collected_at: historyRow.collectedAt });
      historyByMerchant.set(historyRow.merchantId, merchantHistory);
    }
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
        const pickupVolumeForecast = forecastMerchantPickupVolume({
          container_capacity_liters: row.containerCapacityLiters,
          declared_estimated_liters: row.expectedLiters,
          history: historyByMerchant.get(row.merchantId) ?? [],
          as_of: asOf,
        });
        return { row, index, pickupPriority, pickupVolumeForecast };
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
      pickup_volume_forecast: {
        predicted_liters: number | null;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
        sample_size: number;
        reason_codes: string[];
      };
    }> = [];
    const selectedCapacityRiskStops: Array<{
      declared_liters: number | null;
      predicted_liters: number | null;
      forecast_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
      container_capacity_liters: number | null;
    }> = [];
    let total = 0;
    for (const scoredRow of scoredRows) {
      const { row, pickupPriority, pickupVolumeForecast } = scoredRow;
      if (total + row.expectedLiters > maxCapacity) {
        break;
      }
      total += row.expectedLiters;
      selectedCapacityRiskStops.push({
        declared_liters: row.expectedLiters,
        predicted_liters: pickupVolumeForecast.predicted_liters,
        forecast_confidence: pickupVolumeForecast.confidence,
        container_capacity_liters: row.containerCapacityLiters,
      });
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
        pickup_volume_forecast: pickupVolumeForecast,
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
    const routeCapacityRisk = assessCollectorRouteCapacityRisk({
      vehicle_capacity_liters: maxCapacity,
      stops: selectedCapacityRiskStops,
    });
    return {
      stops: orderedStops,
      total_expected_liters: total,
      remaining_capacity_l: Math.max(maxCapacity - total, 0),
      route_optimization: routeOptimization,
      route_capacity_risk: routeCapacityRisk,
      route_id: null,
      route_status: 'PREVIEW',
      persisted: false,
      client_uuid: null,
      started_at: null,
    };
  }

  private async serializePersistedRoute(route: PersistedRoute): Promise<CurrentRouteResponse> {
    const pendingOrderIds = route.stops
      .filter((stop) => stop.status === 'PENDING')
      .map((stop) => stop.orderId);
    const liveRows = await this.prisma.findLiveRouteStopMerchants(pendingOrderIds);
    const liveByOrderId = new Map(liveRows.map((row) => [row.orderId, row]));
    const stops = route.stops.map((stop) => {
      const merchantSnapshot = stop.merchantSnapshot as Record<string, unknown>;
      const aiSnapshot = stop.aiSnapshot as Record<string, unknown>;
      const live = stop.status === 'PENDING' ? liveByOrderId.get(stop.orderId) : undefined;
      const merchant = live
        ? {
            name: live.merchantName,
            address: live.merchantAddress,
            phone: live.merchantPhone,
            lat: live.merchantLat,
            lng: live.merchantLng,
          }
        : merchantSnapshot as unknown as CurrentRouteResponse['stops'][number]['merchant'];
      return {
        seq: stop.sequence,
        order_id: stop.orderId,
        merchant,
        container_code: live?.containerCode ?? String(merchantSnapshot.container_code ?? ''),
        expected_liters: Number(stop.expectedLiters ?? 0),
        priority: Number(aiSnapshot.priority ?? 0),
        distance_m: Number(merchantSnapshot.distance_m ?? 0),
        ward_center: live
          ? live.wardCenterLat === null || live.wardCenterLng === null
            ? null
            : { lat: live.wardCenterLat, lng: live.wardCenterLng }
          : (merchantSnapshot.ward_center as CurrentRouteResponse['stops'][number]['ward_center']) ?? null,
        pickup_priority_score: Number(aiSnapshot.pickup_priority_score ?? 0),
        pickup_priority_level: aiSnapshot.pickup_priority_level as CurrentRouteResponse['stops'][number]['pickup_priority_level'],
        pickup_priority_reason_codes: Array.isArray(aiSnapshot.pickup_priority_reason_codes) ? aiSnapshot.pickup_priority_reason_codes as string[] : [],
        pickup_volume_forecast: aiSnapshot.pickup_volume_forecast as CurrentRouteResponse['stops'][number]['pickup_volume_forecast'],
        route_stop_status: stop.status,
        collected_at: stop.collectedAt?.toISOString() ?? null,
        skipped_at: stop.skippedAt?.toISOString() ?? null,
      };
    });
    return {
      stops,
      total_expected_liters: Number(route.totalExpectedLiters),
      remaining_capacity_l: Number(route.remainingCapacityLiters),
      route_optimization: route.optimizationSnapshot as CurrentRouteResponse['route_optimization'],
      route_capacity_risk: route.capacityRiskSnapshot as CurrentRouteResponse['route_capacity_risk'],
      route_id: route.id,
      route_status: route.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
      persisted: true,
      client_uuid: route.clientUuid,
      started_at: route.startedAt.toISOString(),
    };
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
