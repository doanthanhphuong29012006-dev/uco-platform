import React from 'react';
import { formatLiters } from '../lib/dashboard-utils';

export interface KpiValues {
  liters: number;
  transactions: number;
  merchants: number;
  alerts: number;
}

export function KpiCards({ values }: { values: KpiValues }) {
  const cards = [
    ['Tổng lít hôm nay', formatLiters(values.liters), 'text-emerald-700'],
    ['Giao dịch hôm nay', values.transactions.toLocaleString('vi-VN'), 'text-blue-700'],
    ['Quán hoạt động', values.merchants.toLocaleString('vi-VN'), 'text-violet-700'],
    ['Cảnh báo chưa xử lý', values.alerts.toLocaleString('vi-VN'), values.alerts > 0 ? 'text-red-700' : 'text-emerald-700'],
  ];
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, color]) => <article key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">{label}</p><p className={`mt-3 text-3xl font-bold ${color}`}>{value}</p></article>)}</div>;
}
