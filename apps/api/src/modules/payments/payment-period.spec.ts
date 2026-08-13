import { paymentPeriodBounds, paymentPeriodFor } from './payment-period';

describe('paymentPeriodFor', () => {
  it('uses Asia/Ho_Chi_Minh for Monday 00:30 instead of the previous UTC week', () => {
    const monday0030Vietnam = new Date('2026-08-09T17:30:00.000Z');
    expect(paymentPeriodFor(monday0030Vietnam)).toBe('2026-W33');
    const bounds = paymentPeriodBounds('2026-W33');
    expect(bounds.from.toISOString()).toBe('2026-08-09T17:00:00.000Z');
    expect(bounds.to.toISOString()).toBe('2026-08-16T17:00:00.000Z');
  });
});
