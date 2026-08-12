export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200 ${className}`} aria-label="Đang tải" />;
}

export function EmptyState({ message = 'Chưa có dữ liệu' }: { message?: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">{message}</div>;
}

export function ErrorState({ message = 'Không thể tải dữ liệu. Vui lòng thử lại.' }: { message?: string }) {
  return <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">{message}</div>;
}

export function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'green' | 'red' | 'orange' | 'slate' }) {
  const tones = { green: 'bg-emerald-100 text-emerald-800', red: 'bg-red-100 text-red-800', orange: 'bg-orange-100 text-orange-800', slate: 'bg-slate-100 text-slate-700' };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}
