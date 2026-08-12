import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { fillPercent, formatCurrency, formatDate, formatLiters } from '../lib/formatters';
import { OrderSheet } from '../components/OrderSheet';
import { StatusView } from '../components/StatusView';

const PRICE_PER_LITER = Number(import.meta.env.VITE_ESTIMATED_PRICE_PER_LITER ?? 8000);

export function HomePage() {
  const queryClient = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dashboard = useQuery({ queryKey: ['merchant-dashboard'], queryFn: api.dashboard });
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
  const estimatedMoney = data.liters_this_month * PRICE_PER_LITER;

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
        setNotice('Quán chưa được cấp can. Eco-Oil sẽ liên hệ giao can trong 1-2 ngày làm việc. Hotline: 1900 1234');
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
    <header className="page-header"><div><p className="eyebrow">HÔM NAY</p><h1>Chào quán mình 👋</h1></div><div className="leaf-badge">✦</div></header>
    <section className="hero-card"><div><p className="card-eyebrow">TỔNG THU GOM THÁNG NÀY</p><strong>{formatLiters(data.liters_this_month)}</strong><p className="muted">Ước tính {formatCurrency(estimatedMoney)}</p></div><div className="hero-orb">♻</div></section>
    {notice ? <div className="notice" role="status">{notice}</div> : null}
    <section className="section-block"><div className="section-heading"><h2>Can của quán</h2><span>{data.containers.length} can</span></div>{!hasContainers ? <div className="empty-container-state"><strong>Quán chưa được cấp can</strong><p>Eco-Oil sẽ liên hệ giao can trong 1-2 ngày làm việc.</p><small>Hotline: 1900 1234</small></div> : <div className="container-list">{data.containers.map((container) => { const percentage = fillPercent(container.estimated_liters, container.capacity_l); return <article className="container-card" key={container.code}><div className="container-icon">▣</div><div className="container-main"><div className="container-title-row"><strong>{container.code}</strong><span className={`state-pill state-${container.state.toLowerCase()}`}>{container.state === 'AT_MERCHANT' ? 'Ở quán' : 'Đang vận chuyển'}</span></div><p>{formatLiters(container.capacity_l)} dung tích · Ước tính {percentage}% đầy</p><div className="progress-track"><span style={{ width: `${percentage}%` }} /></div></div></article>; })}</div>}</section>
    <button className={`ready-button ${isWaiting || !availableContainer ? 'ready-button-waiting' : ''}`} onClick={() => setSheetOpen(true)} disabled={isWaiting || !availableContainer}><span className="ready-button-icon">{isWaiting ? '✓' : '↑'}</span><span>{isWaiting ? 'Đã báo, đang chờ thu gom' : availableContainer ? 'Sẵn sàng thu gom' : hasContainers ? 'Can đang trên đường về' : 'Đang chờ được cấp can'}</span></button>
    <section className="stats-grid"><div className="stat-card"><span>Lít tháng này</span><strong>{formatLiters(data.liters_this_month)}</strong></div><div className="stat-card"><span>Tiền ước tính</span><strong>{formatCurrency(estimatedMoney)}</strong></div><div className="stat-card stat-card-wide"><span>Lần thu gần nhất</span><strong>{formatDate(data.last_collected_at)}</strong></div></section>
    {sheetOpen ? <OrderSheet busy={createOrder.isPending} maxLiters={availableContainer?.capacity_l ?? null} onClose={() => setSheetOpen(false)} onSubmit={(liters) => void submitOrder(liters)} /> : null}
  </div>;
}
