export function formatLiters(value: number | null | undefined): string {
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value ?? 0)} lít`;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return 'Chưa có';
  }
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function fillPercent(actual: number, capacity: number | null): number {
  if (!capacity || capacity <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((actual / capacity) * 100));
}

export function currentVietnamWeek(now = new Date()): { period: string; from: string; to: string } {
  const offsetMs = 7 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const isoDay = day.getUTCDay() || 7;
  const monday = new Date(day.getTime() - (isoDay - 1) * 86_400_000);
  const thursday = new Date(day.getTime() + (4 - isoDay) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  const from = new Date(monday.getTime() - offsetMs);
  const to = new Date(from.getTime() + 7 * 86_400_000);
  return { period: `${year}-W${String(week).padStart(2, '0')}`, from: from.toISOString(), to: to.toISOString() };
}
