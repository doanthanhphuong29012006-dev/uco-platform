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
