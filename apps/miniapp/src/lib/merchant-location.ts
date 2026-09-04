import type { GeoPoint } from '@eco-oil/shared-types';
import { isValidGeoPoint } from './zalo-client';

export interface ConfirmedMerchantLocation { point: GeoPoint; capturedAt: number; confirmed: boolean }
export function requireConfirmedMerchantLocation(location: ConfirmedMerchantLocation | null, now = Date.now()): GeoPoint {
  if (!location || !location.confirmed || !isValidGeoPoint(location.point)) throw new Error('Hãy lấy vị trí và xác nhận đây là vị trí quán.');
  if (now - location.capturedAt > 30 * 60_000 || now < location.capturedAt) throw new Error('Vị trí đã cũ. Hãy lấy và xác nhận vị trí quán lại.');
  return location.point;
}
