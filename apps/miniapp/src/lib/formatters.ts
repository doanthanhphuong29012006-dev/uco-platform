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
