export type MerchantPickupPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW' | 'INSUFFICIENT_DATA';

export type MerchantPickupPriorityInput = {
  estimated_liters: number | null;
  container_capacity_liters: number | null;
  days_since_last_collection: number | null;
  distance_km: number | null;
  has_active_pickup: boolean;
};

export type MerchantPickupPriorityReasonCode =
  | 'MISSING_FILL_DATA'
  | 'NEAR_FULL'
  | 'HIGH_FILL'
  | 'MEDIUM_FILL'
  | 'MISSING_COLLECTION_HISTORY'
  | 'OVERDUE_COLLECTION'
  | 'WAITING_LONG'
  | 'MISSING_DISTANCE'
  | 'NEARBY'
  | 'ALREADY_SCHEDULED';

export type MerchantPickupPriorityResult = {
  score: number;
  priority: MerchantPickupPriority;
  reason_codes: MerchantPickupPriorityReasonCode[];
};

function validNonNegative(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function classify(score: number): MerchantPickupPriority {
  if (score >= 80) return 'URGENT';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'NORMAL';
  return 'LOW';
}

export function scoreMerchantPickupPriority(
  input: MerchantPickupPriorityInput,
): MerchantPickupPriorityResult {
  const estimatedLiters = validNonNegative(input.estimated_liters);
  const capacityLiters = validNonNegative(input.container_capacity_liters);
  const reasonCodes: MerchantPickupPriorityReasonCode[] = [];

  if (estimatedLiters === null || capacityLiters === null || capacityLiters === 0) {
    return {
      score: 0,
      priority: 'INSUFFICIENT_DATA',
      reason_codes: ['MISSING_FILL_DATA'],
    };
  }

  const fillPct = Math.min((estimatedLiters / capacityLiters) * 100, 100);
  let score = 0;
  if (fillPct >= 90) {
    score += 60;
    reasonCodes.push('NEAR_FULL');
  } else if (fillPct >= 75) {
    score += 45;
    reasonCodes.push('HIGH_FILL');
  } else if (fillPct >= 50) {
    score += 25;
    reasonCodes.push('MEDIUM_FILL');
  } else {
    score += 5;
  }

  const daysSinceLastCollection = validNonNegative(input.days_since_last_collection);
  if (daysSinceLastCollection === null) {
    reasonCodes.push('MISSING_COLLECTION_HISTORY');
  } else if (daysSinceLastCollection >= 14) {
    score += 25;
    reasonCodes.push('OVERDUE_COLLECTION');
  } else if (daysSinceLastCollection >= 7) {
    score += 15;
    reasonCodes.push('WAITING_LONG');
  } else if (daysSinceLastCollection >= 3) {
    score += 5;
  }

  const distanceKm = validNonNegative(input.distance_km);
  if (distanceKm === null) {
    reasonCodes.push('MISSING_DISTANCE');
  } else if (distanceKm <= 2) {
    score += 10;
    reasonCodes.push('NEARBY');
  } else if (distanceKm <= 5) {
    score += 5;
  }

  if (input.has_active_pickup) {
    score -= 40;
    reasonCodes.push('ALREADY_SCHEDULED');
  }

  const boundedScore = Math.round(Math.min(Math.max(score, 0), 100));
  return {
    score: boundedScore,
    priority: classify(boundedScore),
    reason_codes: [...new Set(reasonCodes)],
  };
}
