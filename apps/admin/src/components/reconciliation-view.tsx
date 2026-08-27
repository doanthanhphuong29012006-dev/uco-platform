'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminTransactionAnomaly } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { formatDate, formatLiters, todayIso } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const anomalyPresentation = {
  NORMAL: { label: 'Bình thường', className: 'bg-emerald-100 text-emerald-800' },
  REVIEW: { label: 'Cần kiểm tra', className: 'bg-orange-100 text-orange-800' },
  HIGH_RISK: { label: 'Rủi ro cao', className: 'bg-red-100 text-red-800' },
} as const;

const anomalyReasonLabels: Record<string, string> = {
  DENSITY_OUTLIER: 'Tỷ lệ kg/lít bất thường',
  MASS_OR_VOLUME_OUTLIER: 'Khối lượng hoặc thể tích lệch mạnh so với lịch sử',
  COLLECTION_TIME_OUTLIER: 'Thời gian thu gom khác thường',
  FREQUENCY_SPIKE: 'Tần suất giao dịch tăng đột biến',
};

export function TransactionAnomalySummary({ anomaly }: { anomaly?: AdminTransactionAnomaly }) {
  if (!anomaly) return null;
  const presentation = anomalyPresentation[anomaly.level];
  return <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600"><div className="flex flex-wrap items-center gap-2"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${presentation.className}`}>{presentation.label}</span><span className="font-semibold text-slate-800">Điểm bất thường: {anomaly.score}/100</span></div><p className="mt-1">Mẫu lịch sử: {anomaly.historySize}</p>{anomaly.reasons.length > 0 ? <ul className="mt-1 list-disc space-y-0.5 pl-4">{anomaly.reasons.map((reason) => <li key={reason}>{anomalyReasonLabels[reason] ?? 'Tín hiệu bất thường cần kiểm tra'}</li>)}</ul> : null}</div>;
}

export function ReconciliationView() {
  const [date, setDate] = useState(todayIso());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const result = useQuery({ queryKey: ['reconciliation', date], queryFn: () => api.reconciliation(date) });
  const downloadCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const csv = await api.reconciliationCsv(date);
      const excelCsv = csv.charCodeAt(0) === 0xfeff ? csv : `\uFEFF${csv}`;
      const url = URL.createObjectURL(new Blob([excelCsv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `eco-oil-reconciliation-${date}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof ApiError ? error.message : 'Không thể tải file đối soát.');
    } finally {
      setExporting(false);
    }
  };
  if (result.isLoading) return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-40" /><Skeleton className="mt-6 h-64" /></AdminShell>;
  if (result.error) return <AdminShell><ErrorState message={result.error instanceof ApiError ? result.error.message : 'Không thể tải dữ liệu đối soát.'} /></AdminShell>;
  if (!result.data) return <AdminShell><EmptyState /></AdminShell>;
  const data = result.data;
  const flagged = Math.abs(data.variance_kg_pct) > (data.variance_threshold_pct ?? 0.02);
  return <AdminShell><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold text-emerald-700">Đối soát 3 lớp theo khối lượng</p><h2 className="mt-1 text-3xl font-bold">Ngày {date}</h2></div><div className="flex flex-wrap items-end gap-2"><label className="text-sm font-semibold text-slate-600">Chọn ngày<input className="mt-1 block min-h-11 rounded-xl border border-slate-300 bg-white px-3" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><button type="button" className="min-h-11 rounded-xl bg-emerald-700 px-4 font-bold text-white disabled:opacity-50" disabled={exporting} onClick={() => void downloadCsv()}>{exporting ? 'Đang tạo file…' : 'Tải CSV'}</button></div></div>{exportError ? <p className="mt-3 text-sm text-red-700">{exportError}</p> : null}
    <div className="mt-6 grid gap-4 md:grid-cols-3"><article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">Quán báo / thu gom</p><p className="mt-2 text-3xl font-bold">{formatLiters(data.collected_liters)}</p><p className="mt-1 text-sm text-slate-600">{data.collected_kg.toFixed(2)} kg</p></article><article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">Đã nộp trạm</p><p className="mt-2 text-3xl font-bold">{formatLiters(data.delivered_liters)}</p><p className="mt-1 text-sm text-slate-600">{data.delivered_kg.toFixed(2)} kg</p></article><article className={`rounded-2xl border p-5 shadow-sm ${flagged ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}><p className="text-sm text-slate-500">Chênh lệch theo kg</p><p className={`mt-2 text-3xl font-bold ${flagged ? 'text-red-700' : 'text-emerald-700'}`}>{data.variance_kg.toFixed(2)} kg</p><p className="mt-1 text-sm">{(data.variance_kg_pct * 100).toFixed(2)}% · {flagged ? 'Cần kiểm tra' : 'Trong ngưỡng'}</p>{data.has_estimated_mass ? <p className="mt-1 text-xs text-amber-800">Có một đầu là số kg ước lượng, chưa cân.</p> : null}</article></div>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Theo người thu gom</h3>{data.by_collector.length === 0 ? <div className="mt-4"><EmptyState message="Ngày này chưa có dữ liệu đối soát." /></div> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Người thu gom</th><th className="pb-3">Đã thu (lít / kg)</th><th className="pb-3">Đã nộp (lít / kg)</th><th className="pb-3">Lệch kg</th><th className="pb-3">Trạng thái</th></tr></thead><tbody>{data.by_collector.map((collector) => <tr key={collector.collector_id} className="border-b align-top last:border-0"><td className="py-3 font-semibold">{collector.name}</td><td className="py-3">{formatLiters(collector.collected_l)} / {collector.collected_kg.toFixed(2)} kg</td><td className="py-3">{formatLiters(collector.delivered_l)} / {collector.delivered_kg.toFixed(2)} kg</td><td className={`py-3 ${collector.status === 'FLAGGED' ? 'font-bold text-red-700' : ''}`}>{collector.variance_kg.toFixed(2)} kg</td><td className="py-3"><Badge tone={collector.status === 'FLAGGED' ? 'red' : 'green'}>{collector.status}</Badge>{collector.has_estimated_mass ? <p className="mt-1 text-xs text-amber-700">Có số kg ước lượng</p> : null}{collector.transactions.length > 0 && <details className="mt-2 text-xs font-normal"><summary className="cursor-pointer text-emerald-700">Xem {collector.transactions.length} giao dịch</summary><div className="mt-2 space-y-2 text-slate-500">{collector.transactions.map((transaction) => <div key={transaction.id} className={transaction.suspected_adulteration ? 'font-semibold text-red-700' : ''}><p>{transaction.merchant_name}: {formatLiters(transaction.liters)} / {transaction.kilograms?.toFixed(2) ?? '—'} kg · Hạng {transaction.grade ?? '—'}{transaction.suspected_adulteration ? ' · Nghi ngờ pha lẫn' : ''} · {transaction.mass_source === 'SCALE' ? 'Đã cân' : 'Ước lượng'}{transaction.image_grade_suggestion ? ` · AI ảnh ${transaction.image_grade_suggestion} (${transaction.image_grade_confidence ?? '—'})${transaction.grade_decision_source === 'MANUAL_OVERRIDE_AI' ? ' · Đã đổi' : ''}` : ''} · {formatDate(transaction.collected_at)}</p><TransactionAnomalySummary anomaly={transaction.anomaly} /></div>)}</div></details>}</td></tr>)}</tbody></table></div>}</section>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold">Giao dịch chưa nộp trạm</h3>{data.undelivered_transactions.length === 0 ? <div className="mt-4"><EmptyState message="Không còn giao dịch chưa nộp trạm." /></div> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b text-xs uppercase text-slate-400"><tr><th className="pb-3">Quán</th><th className="pb-3">Số lít</th><th className="pb-3">Số kg</th><th className="pb-3">Hạng</th><th className="pb-3">Thời gian</th><th className="pb-3">Bất thường</th></tr></thead><tbody>{data.undelivered_transactions.map((transaction) => <tr key={transaction.id} className={`border-b align-top last:border-0 ${transaction.suspected_adulteration ? 'bg-red-50' : ''}`}><td className="py-3 font-semibold">{transaction.merchant_name}</td><td className="py-3">{formatLiters(transaction.liters)}</td><td className="py-3">{transaction.kilograms?.toFixed(2) ?? '—'} kg</td><td className="py-3 font-bold">{transaction.grade ?? '—'}{transaction.suspected_adulteration ? ' · Nghi ngờ pha lẫn' : ''}</td><td className="py-3">{formatDate(transaction.collected_at)}</td><td className="min-w-64 py-3"><TransactionAnomalySummary anomaly={transaction.anomaly} /></td></tr>)}</tbody></table></div>}</section>
  </AdminShell>;
}
