import type { AuthUser } from '@eco-oil/shared-types';

export function isAdminUser(user: AuthUser | null): boolean {
  return user?.role === 'ADMIN';
}

export function calculateVariancePct(collected: number, delivered: number): number {
  return collected === 0 ? 0 : (collected - delivered) / collected;
}

export function formatLiters(value: number): string {
  return `${new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} lít`;
}

export function formatMoney(value: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(value)} đ`;
}

export function formatDate(value: string | null): string {
  if (!value) return 'Chưa có';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentPaymentPeriod(now = new Date()): string {
  const vietnamTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const day = new Date(Date.UTC(vietnamTime.getUTCFullYear(), vietnamTime.getUTCMonth(), vietnamTime.getUTCDate()));
  const isoDay = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - isoDay);
  const year = day.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
