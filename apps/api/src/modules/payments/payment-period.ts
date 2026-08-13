const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaymentPeriodBounds {
  from: Date;
  to: Date;
}

export function paymentPeriodFor(date: Date): string {
  const local = new Date(date.getTime() + VIETNAM_OFFSET_MS);
  const calendarDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const isoDay = calendarDay.getUTCDay() || 7;
  calendarDay.setUTCDate(calendarDay.getUTCDate() + 4 - isoDay);
  const isoYear = calendarDay.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((calendarDay.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function paymentPeriodBounds(period: string): PaymentPeriodBounds {
  const match = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!match) throw new Error('INVALID_PAYMENT_PERIOD');
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthIsoDay = januaryFourth.getUTCDay() || 7;
  const firstMonday = new Date(januaryFourth.getTime() - (januaryFourthIsoDay - 1) * DAY_MS);
  const localMondayUtc = new Date(firstMonday.getTime() + (week - 1) * 7 * DAY_MS);
  const from = new Date(localMondayUtc.getTime() - VIETNAM_OFFSET_MS);
  const to = new Date(from.getTime() + 7 * DAY_MS);
  if (paymentPeriodFor(new Date(from.getTime() + VIETNAM_OFFSET_MS)) !== period) {
    throw new Error('INVALID_PAYMENT_PERIOD');
  }
  return { from, to };
}

export function currentPaymentPeriod(now = new Date()): string {
  return paymentPeriodFor(now);
}
