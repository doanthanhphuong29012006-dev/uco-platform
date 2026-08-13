import { useQuery } from '@tanstack/react-query';
import type { PaymentRecord } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { formatCurrency, formatDate, formatLiters } from '../lib/formatters';
import { StatusView } from '../components/StatusView';

const statusLabel = { PENDING: 'Chờ thanh toán', PAID: 'Đã thanh toán', CANCELLED: 'Đã huỷ' } as const;

export function PaymentsPage() {
  const payments = useQuery({ queryKey: ['merchant-payments'], queryFn: () => api.payments() });
  if (payments.isPending) return <StatusView title="Đang tải thanh toán…" />;
  if (payments.isError) return <StatusView title="Chưa tải được thanh toán" message={payments.error instanceof ApiError ? payments.error.message : 'Vui lòng kiểm tra kết nối và thử lại.'} action={{ label: 'Thử lại', onClick: () => { void payments.refetch(); } }} />;
  if (!payments.data.data.length) return <StatusView title="Chưa có kỳ thanh toán" message="Sau khi Eco-Oil chốt kỳ, số tiền và trạng thái thanh toán sẽ xuất hiện tại đây." />;
  const periods = payments.data.data.reduce<Map<string, PaymentRecord[]>>((groups, payment) => {
    const rows = groups.get(payment.period) ?? [];
    rows.push(payment);
    groups.set(payment.period, rows);
    return groups;
  }, new Map());
  return <div className="page-content"><header className="page-header"><div><p className="eyebrow">MINH BẠCH THEO KỲ</p><h1>Tiền dầu của quán</h1></div></header><section className="payment-period-list">{Array.from(periods.entries()).map(([period, rows]) => <article className="payment-period-card" key={period}><div className="payment-period-heading"><div><span>Kỳ {period}</span><strong>{formatCurrency(rows.reduce((sum, row) => sum + row.amount, 0))}</strong></div><span>{formatLiters(rows.reduce((sum, row) => sum + row.liters, 0))}</span></div><div className="payment-lines">{rows.map((payment) => <div key={payment.id}><div><strong>{formatLiters(payment.liters)} × {formatCurrency(payment.unit_price)}</strong><small>{formatDate(payment.collected_at)}</small></div><span className={`payment-status payment-status-${payment.status.toLowerCase()}`}>{statusLabel[payment.status]}</span></div>)}</div></article>)}</section></div>;
}
