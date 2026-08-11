export interface PriorityInput {
  expectedLiters: number;
  capacityL: number;
  daysSinceLastCollection: number;
}

export function calculatePriority(input: PriorityInput): number {
  const fillRatio = input.capacityL > 0 ? Math.min(Math.max(input.expectedLiters / input.capacityL, 0), 1) : 0;
  const daysRatio = Math.min(Math.max(input.daysSinceLastCollection, 0), 14) / 14;
  return Math.min(Math.max(fillRatio * 60 + daysRatio * 40, 0), 100);
}
