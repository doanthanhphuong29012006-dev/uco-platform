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
