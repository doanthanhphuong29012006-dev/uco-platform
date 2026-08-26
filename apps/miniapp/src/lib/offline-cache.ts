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
    void prefetchRouteData(route, location ?? null, ownerId);
    return { route, fromCache: false, cachedAt: null };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const cached = await getCachedRoute(ownerId);
    if (!cached) {
      throw error;
    }
    return { route: cached.payload, fromCache: true, cachedAt: cached.updated_at };
  }
}

export async function lookupContainerWithCache(code: string): Promise<{ container: ContainerLookupResponse; fromCache: boolean; cachedAt: string | null }> {
  try {
    const container = await api.containerByQr(code);
    await cacheContainer(container);
    return { container, fromCache: false, cachedAt: null };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const cached = await getCachedContainer(code);
    if (!cached) {
      throw error;
    }
    return { container: cached.payload, fromCache: true, cachedAt: cached.updated_at };
  }
}
