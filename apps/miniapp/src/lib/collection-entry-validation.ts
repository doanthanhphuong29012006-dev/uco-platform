import { OilGrade, Quality } from '@eco-oil/shared-types';

export function parseLocalizedDecimal(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

export interface CollectionSubmitValidation {
  grade: OilGrade | null;
  quality: Quality;
  photoCount: number;
  suspectedAdulteration: boolean;
  hasLiters: boolean;
  hasKilograms: boolean;
  invalidMass: boolean;
  invalidLitersMessage: string;
  highDeviationNeedsAcknowledgement: boolean;
  imageGradeDecisionBlocked: boolean;
}

export function getCollectionSubmitBlockReasons(
  state: CollectionSubmitValidation,
): string[] {
  const reasons: string[] = [];
  if (state.grade === null) reasons.push('Chọn hạng dầu A, B hoặc C.');
  if (state.invalidMass) {
    reasons.push(
      !state.hasLiters && !state.hasKilograms
        ? 'Nhập số kg hoặc số lít lớn hơn 0.'
        : state.invalidLitersMessage,
    );
  }
  const photoRequired =
    state.grade === OilGrade.B ||
    state.grade === OilGrade.C ||
    state.quality === Quality.FLAG ||
    state.suspectedAdulteration;
  if (photoRequired && state.photoCount === 0) {
    reasons.push('Thêm ít nhất một ảnh cho hạng B/C, “Cần kiểm tra” hoặc nghi ngờ pha lẫn.');
  }
  if (state.highDeviationNeedsAcknowledgement) {
    reasons.push('Xác nhận đã kiểm tra cảnh báo chênh lệch sản lượng.');
  }
  if (state.imageGradeDecisionBlocked) {
    reasons.push('Xác nhận giữ hạng thủ công đang khác gợi ý AI.');
  }
  return reasons;
}
