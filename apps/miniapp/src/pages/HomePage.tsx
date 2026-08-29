import { useState } from 'react';
import { DEFAULT_DENSITY_KG_PER_LITER } from '@eco-oil/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { currentVietnamWeek, fillPercent, formatCurrency, formatDate, formatLiters } from '../lib/formatters';
import { OrderSheet } from '../components/OrderSheet';
import { StatusView } from '../components/StatusView';
import { useAuthStore } from '../stores/auth-store';

const PRICE_PER_LITER = Number(import.meta.env.VITE_ESTIMATED_PRICE_PER_LITER ?? 8000);

export function HomePage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const identityKey = user?.id ?? 'unknown';
  const dashboard = useQuery({ queryKey: ['merchant-dashboard', identityKey], queryFn: api.dashboard });
  const week = currentVietnamWeek();
  const weeklyPayments = useQuery({ queryKey: ['merchant-payments', identityKey, week.period], queryFn: () => api.payments(week.period) });
  const weeklyTransactions = useQuery({ queryKey: ['merchant-transactions', identityKey, week.period], queryFn: () => api.transactions(1, 100, week.from, week.to) });
  const createOrder = useMutation({
    mutationFn: (liters: number | undefined) => api.createReadyOrder(liters),
    onSuccess: async (order) => {
      setSheetOpen(false);
      setNotice(order.collector_available === false ? 'Đơn đã ghi nhận, khu vực chưa có người thu gom phụ trách' : 'Đã báo, đang chờ thu gom');
      await queryClient.invalidateQueries({ queryKey: ['merchant-dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['merchant-orders'] });
    },
  });

  if (dashboard.isPending) return <StatusView title="Đang tải thông tin quán…" />;
  if (dashboard.isError) return <StatusView title="Chưa tải được dữ liệu" message="Kiểm tra kết nối rồi thử lại nhé." action={{ label: 'Thử lại', onClick: () => { void dashboard.refetch(); } }} />;

  const data = dashboard.data;
  const hasContainers = data.containers.length > 0;
  const availableContainer = data.containers.find((container) => container.state === 'AT_MERCHANT');
  const isWaiting = data.pending_orders > 0;
  const hasClosedPayments = (weeklyPayments.data?.data.length ?? 0) > 0;
  const estimatedWeeklyLiters = weeklyTransactions.data?.data.filter((transaction) => transaction.quality === 'PASS').reduce((sum, transaction) => sum + transaction.actual_liters, 0) ?? 0;
  const estimatedWeeklyKg = weeklyTransactions.data?.data.filter((transaction) => transaction.quality === 'PASS').reduce((sum, transaction) => sum + (transaction.actual_kg ?? transaction.actual_liters * DEFAULT_DENSITY_KG_PER_LITER), 0) ?? 0;
  const weeklyMoney = hasClosedPayments ? weeklyPayments.data?.totals.amount ?? 0 : estimatedWeeklyLiters * PRICE_PER_LITER;

  async function submitOrder(liters: number | undefined) {
    setNotice(null);
    try {
      await createOrder.mutateAsync(liters);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ORDER_ALREADY_OPEN') {
        setSheetOpen(false);
        setNotice('Đã báo, đang chờ thu gom');
        await queryClient.invalidateQueries({ queryKey: ['merchant-dashboard'] });
        return;
      }
      if (error instanceof ApiError && error.code === 'NO_CONTAINER_ASSIGNED') {
        setSheetOpen(false);
        setNotice('Quán chưa được cấp can. ECollect sẽ liên hệ giao can trong 1-2 ngày làm việc. Hotline: 1900 1234');
        await queryClient.invalidateQueries({ queryKey: ['merchant-dashboard'] });
        return;
      }
      if (error instanceof ApiError && error.code === 'NO_CONTAINER_AVAILABLE') {
        setSheetOpen(false);
        setNotice('Can đang trên đường về, chưa thể báo thu gom');
        return;
      }
      setNotice(error instanceof ApiError ? error.message : 'Chưa gửi được yêu cầu. Vui lòng thử lại sau.');
    }
  }

  return <div className="page-content">
    <header className="page-header"><div><p className="eyebrow">HÔM NAY</p><h1>Xin chào, {user?.name ?? 'quán của bạn'}</h1><small>Mã quán: {user?.zalo_id ?? 'Chưa xác định'}</small></div></header>
    <section className="hero-card"><div><p className="card-eyebrow">TIỀN TUẦN NÀY · {week.period}</p><strong>{formatCurrency(weeklyMoney)}</strong><p className="muted">{hasClosedPayments ? 'Số tiền đã chốt theo giao dịch' : 'Ước tính, kỳ chưa được chốt'} · {estimatedWeeklyKg.toFixed(1)} kg</p></div></section>
    {notice ? <div className="notice" role="status">{notice}</div> : null}
    <section className="section-block"><div className="section-heading"><h2>Can của quán</h2><span>{data.containers.length} can</span></div>{!hasContainers ? <div className="empty-container-state"><strong>Quán chưa được cấp can</strong><p>ECollect sẽ liên hệ giao can trong 1-2 ngày làm việc.</p><small>Hotline: 1900 1234</small></div> : <div className="container-list">{data.containers.map((container) => { const percentage = fillPercent(container.estimated_liters, container.capacity_l); return <article className="container-card" key={container.code}><div className="container-main"><div className="container-title-row"><strong>{container.code}</strong><span className={`state-pill state-${container.state.toLowerCase()}`}>{container.state === 'AT_MERCHANT' ? 'Ở quán' : 'Đang vận chuyển'}</span></div><p>{formatLiters(container.capacity_l)} dung tích · Ước tính {percentage}% đầy</p><div className="progress-track" aria-label={`${percentage}% đầy`}><span style={{ width: `${percentage}%` }} /></div></div></article>; })}</div>}</section>
    <button className={`ready-button ${isWaiting || !availableContainer ? 'ready-button-waiting' : ''}`} onClick={() => setSheetOpen(true)} disabled={isWaiting || !availableContainer}>{isWaiting ? 'Đã báo, đang chờ thu gom' : availableContainer ? 'Sẵn sàng thu gom' : hasContainers ? 'Can đang trên đường về' : 'Đang chờ được cấp can'}</button>
    <section className="stats-grid"><div className="stat-card"><span>Lít tháng này</span><strong>{formatLiters(data.liters_this_month)}</strong></div><div className="stat-card"><span>{hasClosedPayments ? 'Tiền đã chốt tuần này' : 'Tiền ước tính tuần này'}</span><strong>{formatCurrency(weeklyMoney)}</strong></div><div className="stat-card stat-card-wide"><span>Lần thu gần nhất</span><strong>{formatDate(data.last_collected_at)}</strong></div></section>
    {sheetOpen ? <OrderSheet busy={createOrder.isPending} maxLiters={availableContainer?.capacity_l ?? null} onClose={() => setSheetOpen(false)} onSubmit={(liters) => void submitOrder(liters)} /> : null}
  </div>;
}
