import { calculatePriority } from './priority';

describe('calculatePriority', () => {
  it('scores a nearly full container collected today', () => {
    expect(calculatePriority({ expectedLiters: 25, capacityL: 30, daysSinceLastCollection: 0 })).toBe(50);
  });

  it('scores a low-fill container that has waited several days', () => {
    expect(calculatePriority({ expectedLiters: 5, capacityL: 30, daysSinceLastCollection: 3 })).toBeCloseTo(18.5714, 3);
  });

  it('scores a full container that has waited beyond the cap', () => {
    expect(calculatePriority({ expectedLiters: 30, capacityL: 30, daysSinceLastCollection: 20 })).toBe(100);
  });
});
