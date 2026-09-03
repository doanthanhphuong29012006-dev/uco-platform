import type { ContainerLookupResponse, CurrentRouteResponse, GeoPoint } from '@eco-oil/shared-types';
import { ApiError, api } from './api';
import {
  cacheContainer,
  cacheRoute,
  getCachedContainer,
  getCachedRoute,
} from './outbox-db';

export interface RouteLoadResult {
  route: CurrentRouteResponse;
  fromCache: boolean;
  cachedAt: string | null;
}

export function canUseOfflineCache(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0
    || error.status === 408
    || error.status === 429
    || error.status >= 500;
}

export async function prefetchRouteData(route: CurrentRouteResponse, location: GeoPoint | null, ownerId?: string | null): Promise<void> {
  await cacheRoute(route, location, ownerId);
  await Promise.all(route.stops.map(async (stop) => {
    try {
      await cacheContainer(await api.containerByQr(stop.container_code));
    } catch {
      // A route remains useful offline even when one optional container prefetch fails.
    }
  }));
}

export async function loadRouteWithCache(location?: GeoPoint, ownerId?: string | null): Promise<RouteLoadResult> {
  try {
    const route = await api.currentRoute(location);
    await cacheRoute(route, location ?? null, ownerId);
    void Promise.all(route.stops.map(async (stop) => {
      try {
        await cacheContainer(await api.containerByQr(stop.container_code));
      } catch {
        // Container details are optional for displaying the recovered route.
      }
    }));
    console.info('[collector-route]', {
      collector_id: ownerId ?? null,
      route_id: route.route_id,
      route_status: route.route_status,
      order_statuses: route.stops.map((stop) => ({
        order_id: stop.order_id,
        status: stop.route_stop_status ?? 'READY',
      })),
      source: 'server',
    });
    return { route, fromCache: false, cachedAt: null };
  } catch (error) {
    if (!canUseOfflineCache(error)) {
      throw error;
    }
    const cached = await getCachedRoute(ownerId);
    if (!cached) {
      throw error;
    }
    console.info('[collector-route]', {
      collector_id: ownerId ?? null,
      route_id: cached.payload.route_id,
      route_status: cached.payload.route_status,
      order_statuses: cached.payload.stops.map((stop) => ({
        order_id: stop.order_id,
        status: stop.route_stop_status ?? 'READY',
      })),
      source: 'cache',
    });
    return { route: cached.payload, fromCache: true, cachedAt: cached.updated_at };
  }
}

export async function lookupContainerWithCache(code: string): Promise<{ container: ContainerLookupResponse; fromCache: boolean; cachedAt: string | null }> {
  try {
    const container = await api.containerByQr(code);
    await cacheContainer(container);
    return { container, fromCache: false, cachedAt: null };
  } catch (error) {
    if (!canUseOfflineCache(error)) {
      throw error;
    }
    const cached = await getCachedContainer(code);
    if (!cached) {
      throw error;
    }
    return { container: cached.payload, fromCache: true, cachedAt: cached.updated_at };
  }
}
