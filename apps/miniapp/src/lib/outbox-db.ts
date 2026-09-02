import Dexie, { type Table } from 'dexie';
import type { CollectionCreateRequest, ContainerLookupResponse, CurrentRouteResponse, StationDeliveryCreateRequest } from '@eco-oil/shared-types';

export type OutboxType = 'collection' | 'station_delivery';
export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface OutboxRecord {
  client_uuid: string;
  owner_id?: string;
  type: OutboxType;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  synced_at: string | null;
  updated_at?: string;
  sync_started_at?: string | null;
  server_id?: string;
  server_response?: unknown;
}

export interface CachedRouteRecord {
  key: string;
  owner_id?: string;
  payload: CurrentRouteResponse;
  location: { lat: number; lng: number } | null;
  updated_at: string;
}

export interface CachedContainerRecord {
  qr_code: string;
  payload: ContainerLookupResponse;
  updated_at: string;
}

export interface StationReceiptTransaction {
  transaction_id: string;
  merchant_name: string;
  liters: number;
  kilograms: number | null;
  collected_at: string | null;
}

export interface StoredStationReceipt {
  receipt_id: string;
  client_uuid: string;
  station_id: string;
  station_name: string;
  collector_id: string;
  created_at: string;
  expected_liters: number;
  expected_kg: number | null;
  actual_liters: number | null;
  actual_kg: number | null;
  variance_liters: number | null;
  variance_kg: number | null;
  variance_pct: number | null;
  units: { volume: 'lít'; mass: 'kg' };
  transactions: StationReceiptTransaction[];
}

interface StationReceiptRecord {
  key: string;
  owner_id: string;
  created_at: string;
  receipt: StoredStationReceipt;
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
  recoverStaleSyncing?(now: Date): Promise<number>;
}

export class EcoOilDatabase extends Dexie {
  outbox!: Table<OutboxRecord, string>;
  routeCache!: Table<CachedRouteRecord, string>;
  containerCache!: Table<CachedContainerRecord, string>;
  stationReceipts!: Table<StationReceiptRecord, string>;

  constructor() {
    super('eco-oil-miniapp');
    this.version(1).stores({
      outbox: '&client_uuid,status,next_attempt_at,created_at,synced_at',
      routeCache: '&key,updated_at',
      containerCache: '&qr_code,updated_at',
    });
    this.version(2).stores({
      outbox: '&client_uuid,status,next_attempt_at,created_at,synced_at',
      routeCache: '&key,updated_at',
      containerCache: '&qr_code,updated_at',
      stationReceipts: '&key,owner_id,created_at',
    });
  }
}

export let ecoOilDb = new EcoOilDatabase();
let activeOutboxOwnerId: string | null = null;
let legacyClaimOwnerId: string | null = null;
const OUTBOX_LIMIT_BYTES = 50 * 1024 * 1024;
const subscribers = new Set<() => void>();
export const OUTBOX_OPERATION_TIMEOUT_MS = 4_500;

export function setOutboxOwner(ownerId: string | null): void {
  if (activeOutboxOwnerId === ownerId) return;
  activeOutboxOwnerId = ownerId;
  legacyClaimOwnerId = ownerId;
  emitChanged();
  if (ownerId) {
    void claimLegacyOutboxRecords(ownerId).catch((error: unknown) => {
      console.warn('[outbox] Không thể gắn owner cho dữ liệu cũ', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}

function belongsToActiveOwner(record: OutboxRecord): boolean {
  if (activeOutboxOwnerId === null) return false;
  return (
    record.owner_id === activeOutboxOwnerId ||
    (!record.owner_id && legacyClaimOwnerId === activeOutboxOwnerId)
  );
}

function requireActiveOutboxOwner(): string {
  if (!activeOutboxOwnerId) {
    throw new Error('Thiếu tài khoản người thu gom để lưu hàng chờ.');
  }
  return activeOutboxOwnerId;
}

export async function claimLegacyOutboxRecords(ownerId: string): Promise<number> {
  if (!ownerId.trim()) return 0;
  const legacyRecords = await ecoOilDb.outbox.filter((record) => !record.owner_id).toArray();
  if (legacyRecords.length === 0) return 0;
  await ecoOilDb.transaction('rw', ecoOilDb.outbox, async () => {
    for (const record of legacyRecords) {
      await ecoOilDb.outbox.put({ ...record, owner_id: ownerId });
    }
  });
  if (activeOutboxOwnerId === ownerId) legacyClaimOwnerId = null;
  emitChanged();
  return legacyRecords.length;
}

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
    await ecoOilDb.outbox.put(record);
    emitChanged();
  },
  async getPending(limit, now) {
    const records = await ecoOilDb.outbox.where('status').equals('pending').toArray();
    return records
      .filter(belongsToActiveOwner)
      .filter((record) => !record.next_attempt_at || new Date(record.next_attempt_at) <= now)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, limit);
  },
  get(clientUuid) {
    return ecoOilDb.outbox.get(clientUuid).then((record) => record && belongsToActiveOwner(record) ? record : undefined);
  },
  async update(record) {
    await ecoOilDb.outbox.put(record);
    emitChanged();
  },
  async list(limit = 100) {
    return (await ecoOilDb.outbox.orderBy('created_at').reverse().toArray())
      .filter(belongsToActiveOwner)
      .slice(0, limit);
  },
  async deleteSyncedBefore(cutoff) {
    const records = await ecoOilDb.outbox.where('status').equals('synced').toArray();
    const expired = records.filter((record) => belongsToActiveOwner(record) && record.synced_at && new Date(record.synced_at) < cutoff);
    await ecoOilDb.outbox.bulkDelete(expired.map((record) => record.client_uuid));
    if (expired.length > 0) {
      emitChanged();
    }
    return expired.length;
  },
  async stats() {
    const records = (await ecoOilDb.outbox.toArray()).filter(belongsToActiveOwner);
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
  async recoverStaleSyncing(now) {
    const cutoff = now.getTime() - 60_000;
    const records = (await ecoOilDb.outbox.where('status').equals('syncing').toArray()).filter(belongsToActiveOwner);
    const stale = records.filter((record) => {
      const startedAt = record.sync_started_at ?? record.updated_at ?? record.created_at;
      return new Date(startedAt).getTime() <= cutoff;
    });
    for (const record of stale) {
      await ecoOilDb.outbox.put({
        ...record,
        status: 'pending',
        sync_started_at: null,
        updated_at: now.toISOString(),
      });
    }
    if (stale.length > 0) emitChanged();
    return stale.length;
  },
};

export function subscribeOutbox(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function withDeadline<T>(operation: () => Promise<T>, timeoutMs = OUTBOX_OPERATION_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lưu dữ liệu trên máy quá thời gian cho phép')), timeoutMs);
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface OutboxPersistenceOptions {
  store?: OutboxStore;
  reopen?: () => OutboxStore;
  timeoutMs?: number;
}

function reopenDexieStore(): OutboxStore {
  try {
    ecoOilDb.close();
  } catch {
    // Continue with a fresh connection when the old IndexedDB handle is broken.
  }
  ecoOilDb = new EcoOilDatabase();
  return dexieOutboxStore;
}

async function persistOutboxRecord(record: OutboxRecord, options: OutboxPersistenceOptions = {}): Promise<OutboxRecord> {
  let store = options.store ?? dexieOutboxStore;
  const reopen = options.reopen ?? (options.store ? () => store : reopenDexieStore);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const existing = await withDeadline(() => store.get(record.client_uuid), options.timeoutMs);
      if (existing) return existing;

      await withDeadline(() => store.addPending(record), options.timeoutMs);
      const saved = await withDeadline(() => store.get(record.client_uuid), options.timeoutMs);
      if (!saved) throw new Error('Không xác nhận được dữ liệu đã lưu trên máy');
      return saved;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        store = reopen();
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Không lưu được dữ liệu trên máy');
}

export async function persistOutboxForTest(record: OutboxRecord, options: OutboxPersistenceOptions): Promise<OutboxRecord> {
  return persistOutboxRecord(record, options);
}

export async function enqueueCollection(payload: CollectionCreateRequest): Promise<OutboxRecord> {
  const now = new Date().toISOString();
  const ownerId = requireActiveOutboxOwner();
  const record: OutboxRecord = {
    client_uuid: payload.client_uuid,
    owner_id: ownerId,
    type: 'collection',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: now,
    synced_at: null,
    updated_at: now,
    sync_started_at: null,
  };
  return persistOutboxRecord(record);
}

export async function enqueueStationDelivery(payload: StationDeliveryCreateRequest): Promise<OutboxRecord> {
  const now = new Date().toISOString();
  const ownerId = requireActiveOutboxOwner();
  const record: OutboxRecord = {
    client_uuid: payload.client_uuid,
    owner_id: ownerId,
    type: 'station_delivery',
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    created_at: now,
    synced_at: null,
    updated_at: now,
    sync_started_at: null,
  };
  return persistOutboxRecord(record);
}

export async function retryOutbox(clientUuid: string): Promise<void> {
  const record = await dexieOutboxStore.get(clientUuid);
  if (!record) {
    return;
  }
  await dexieOutboxStore.update({ ...record, status: 'pending', attempts: 0, last_error: null, next_attempt_at: null, sync_started_at: null, updated_at: new Date().toISOString() });
}

function routeCacheKey(ownerId?: string | null): string {
  return ownerId ? `current:${ownerId}` : 'current';
}

export async function cacheRoute(payload: CurrentRouteResponse, location: { lat: number; lng: number } | null, ownerId?: string | null): Promise<void> {
  const key = routeCacheKey(ownerId ?? activeOutboxOwnerId);
  await ecoOilDb.routeCache.put({ key, owner_id: ownerId ?? activeOutboxOwnerId ?? undefined, payload, location, updated_at: new Date().toISOString() });
}

export async function getCachedRoute(ownerId?: string | null): Promise<CachedRouteRecord | undefined> {
  return ecoOilDb.routeCache.get(routeCacheKey(ownerId ?? activeOutboxOwnerId));
}

export async function cacheContainer(payload: ContainerLookupResponse): Promise<void> {
  await ecoOilDb.containerCache.put({ qr_code: payload.qr_code, payload, updated_at: new Date().toISOString() });
}

export async function getCachedContainer(qrCode: string): Promise<CachedContainerRecord | undefined> {
  return ecoOilDb.containerCache.get(qrCode);
}

function stationReceiptKey(ownerId: string, receiptId: string): string {
  return `${ownerId}:${receiptId}`;
}

export async function saveStationReceipt(ownerId: string, receipt: StoredStationReceipt): Promise<void> {
  if (!ownerId.trim()) throw new Error('Thiếu tài khoản để lưu biên nhận');
  const key = stationReceiptKey(ownerId, receipt.receipt_id);
  await ecoOilDb.stationReceipts.put({ key, owner_id: ownerId, created_at: receipt.created_at, receipt });
  const saved = await ecoOilDb.stationReceipts.get(key);
  if (!saved || saved.receipt.receipt_id !== receipt.receipt_id || saved.owner_id !== ownerId) {
    throw new Error('Không xác nhận được biên nhận đã lưu trên máy');
  }
}

export async function getLatestStationReceipt(ownerId: string): Promise<StoredStationReceipt | null> {
  if (!ownerId.trim()) return null;
  const records = await ecoOilDb.stationReceipts.where('owner_id').equals(ownerId).toArray();
  records.sort((left, right) => right.created_at.localeCompare(left.created_at));
  return records[0]?.receipt ?? null;
}

export const OUTBOX_RETENTION_DAYS = 7;
export const OUTBOX_BATCH_SIZE = 20;
export const OUTBOX_LIMIT_MB = 50;
