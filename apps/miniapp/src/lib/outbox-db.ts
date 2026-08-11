import Dexie, { type Table } from 'dexie';
import type { CollectionCreateRequest, ContainerLookupResponse, CurrentRouteResponse, StationDeliveryCreateRequest } from '@eco-oil/shared-types';

export type OutboxType = 'collection' | 'station_delivery';
export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface OutboxRecord {
  client_uuid: string;
  type: OutboxType;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  synced_at: string | null;
  server_id?: string;
  server_response?: unknown;
}

export interface CachedRouteRecord {
  key: 'current';
  payload: CurrentRouteResponse;
  location: { lat: number; lng: number } | null;
  updated_at: string;
}

export interface CachedContainerRecord {
  qr_code: string;
  payload: ContainerLookupResponse;
  updated_at: string;
}

export interface OutboxStats {
  pending: number;
  syncing: number;
  failed: number;
  synced: number;
  bytes: number;
  over_limit: boolean;
}

export interface OutboxStore {
  addPending(record: OutboxRecord): Promise<void>;
  getPending(limit: number, now: Date): Promise<OutboxRecord[]>;
  get(clientUuid: string): Promise<OutboxRecord | undefined>;
  update(record: OutboxRecord): Promise<void>;
  list(limit?: number): Promise<OutboxRecord[]>;
  deleteSyncedBefore(cutoff: Date): Promise<number>;
  stats(): Promise<OutboxStats>;
}

export class EcoOilDatabase extends Dexie {
  outbox!: Table<OutboxRecord, string>;
  routeCache!: Table<CachedRouteRecord, string>;
  containerCache!: Table<CachedContainerRecord, string>;

  constructor() {
    super('eco-oil-miniapp');
    this.version(1).stores({
      outbox: '&client_uuid,status,next_attempt_at,created_at,synced_at',
      routeCache: '&key,updated_at',
      containerCache: '&qr_code,updated_at',
    });
  }
}

export const ecoOilDb = new EcoOilDatabase();
const OUTBOX_LIMIT_BYTES = 50 * 1024 * 1024;
const subscribers = new Set<() => void>();

function emitChanged(): void {
  for (const listener of subscribers) {
    listener();
  }
}

function payloadBytes(payload: unknown): number {
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    return payload.size;
  }
  if (typeof payload === 'string') {
    return new TextEncoder().encode(payload).byteLength;
  }
  if (Array.isArray(payload)) {
    return payload.reduce((total, item) => total + payloadBytes(item), 0);
  }
  if (typeof payload === 'object' && payload !== null) {
    return Object.values(payload).reduce((total, item) => total + payloadBytes(item), 0);
  }
  return 0;
}

function recordBytes(record: OutboxRecord): number {
  return payloadBytes(record.payload) + 256;
}

export const dexieOutboxStore: OutboxStore = {
  async addPending(record) {
    await ecoOilDb.outbox.add(record);
    emitChanged();
  },
  async getPending(limit, now) {
    const records = await ecoOilDb.outbox.where('status').equals('pending').toArray();
    return records
      .filter((record) => !record.next_attempt_at || new Date(record.next_attempt_at) <= now)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, limit);
  },
  get(clientUuid) {
    return ecoOilDb.outbox.get(clientUuid);
  },
  async update(record) {
    await ecoOilDb.outbox.put(record);
    emitChanged();
  },
  async list(limit = 100) {
    return (await ecoOilDb.outbox.orderBy('created_at').reverse().limit(limit).toArray());
  },
  async deleteSyncedBefore(cutoff) {
    const records = await ecoOilDb.outbox.where('status').equals('synced').toArray();
    const expired = records.filter((record) => record.synced_at && new Date(record.synced_at) < cutoff);
    await ecoOilDb.outbox.bulkDelete(expired.map((record) => record.client_uuid));
    if (expired.length > 0) {
      emitChanged();
    }
    return expired.length;
  },
  async stats() {
    const records = await ecoOilDb.outbox.toArray();
    const stats = records.reduce<OutboxStats>(
      (current, record) => {
        current[record.status] += 1;
        current.bytes += recordBytes(record);
        return current;
      },
      { pending: 0, syncing: 0, failed: 0, synced: 0, bytes: 0, over_limit: false },
    );
    stats.over_limit = stats.bytes > OUTBOX_LIMIT_BYTES;
    return stats;
  },
};

export function subscribeOutbox(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export async function enqueueCollection(payload: CollectionCreateRequest): Promise<OutboxRecord> {
  const record: OutboxRecord = {
    client_uuid: payload.client_uuid,
    type: 'collection',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };
  await dexieOutboxStore.addPending(record);
  return record;
}

export async function enqueueStationDelivery(payload: StationDeliveryCreateRequest): Promise<OutboxRecord> {
  const record: OutboxRecord = {
    client_uuid: payload.client_uuid,
    type: 'station_delivery',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };
  await dexieOutboxStore.addPending(record);
  return record;
}

export async function retryOutbox(clientUuid: string): Promise<void> {
  const record = await dexieOutboxStore.get(clientUuid);
  if (!record) {
    return;
  }
  await dexieOutboxStore.update({ ...record, status: 'pending', attempts: 0, last_error: null, next_attempt_at: null });
}

export async function cacheRoute(payload: CurrentRouteResponse, location: { lat: number; lng: number } | null): Promise<void> {
  await ecoOilDb.routeCache.put({ key: 'current', payload, location, updated_at: new Date().toISOString() });
}

export async function getCachedRoute(): Promise<CachedRouteRecord | undefined> {
  return ecoOilDb.routeCache.get('current');
}

export async function cacheContainer(payload: ContainerLookupResponse): Promise<void> {
  await ecoOilDb.containerCache.put({ qr_code: payload.qr_code, payload, updated_at: new Date().toISOString() });
}

export async function getCachedContainer(qrCode: string): Promise<CachedContainerRecord | undefined> {
  return ecoOilDb.containerCache.get(qrCode);
}

export const OUTBOX_RETENTION_DAYS = 7;
export const OUTBOX_BATCH_SIZE = 20;
export const OUTBOX_LIMIT_MB = 50;
