import type { StationRecommendation } from '@eco-oil/shared-types';
import type { SyncSummary } from './outbox-sync';

export interface StationDeliverySubmitState {
  invalid: boolean;
  flagged: boolean;
  note: string;
  photoCount: number;
}

export function canSubmitStationDelivery(state: StationDeliverySubmitState): boolean {
  return !state.invalid && (!state.flagged || (state.note.trim().length > 0 && state.photoCount > 0));
}

export async function retryStationDeliverySync(
  sync: () => Promise<SyncSummary>,
  setLoading: (loading: boolean) => void,
  setError: (message: string | null) => void,
): Promise<boolean> {
  setLoading(true);
  setError(null);
  try {
    const summary = await sync();
    if (summary.failed > 0) {
      setError(`${summary.failed} giao dịch chưa đồng bộ được. Vui lòng thử lại.`);
      return false;
    }
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Không thể đồng bộ giao dịch. Vui lòng thử lại.');
    return false;
  } finally {
    setLoading(false);
  }
}

export type StationRecommendationLoadResult =
  | { status: 'success'; stations: StationRecommendation[]; error: null }
  | { status: 'empty'; stations: []; error: null }
  | { status: 'error'; stations: []; error: string };

export async function loadStationRecommendations(
  request: () => Promise<StationRecommendation[]>,
  setLoading: (loading: boolean) => void,
  timeoutMs = 15_000,
): Promise<StationRecommendationLoadResult> {
  setLoading(true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stations = await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Yêu cầu tìm trạm đã quá thời gian chờ.')), timeoutMs);
      }),
    ]);
    return stations.length > 0
      ? { status: 'success', stations, error: null }
      : { status: 'empty', stations: [], error: null };
  } catch (error) {
    return {
      status: 'error',
      stations: [],
      error: error instanceof Error ? error.message : 'Không thể tải danh sách trạm.',
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    setLoading(false);
  }
}
