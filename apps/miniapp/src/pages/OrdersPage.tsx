import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OrderStatus } from '@eco-oil/shared-types';
import { api } from '../lib/api';
import { formatDate, formatLiters } from '../lib/formatters';
import { StatusView } from '../components/StatusView';
import { useAuthStore } from '../stores/auth-store';

export function OrdersPage() {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id ?? 'unknown');
  const [cancelId, setCancelId] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ['merchant-orders', userId], queryFn: api.orders });
  const cancelOrder = useMutation({
    mutationFn: (id: string) => api.cancelOrder(id),
    onSuccess: async () => {
      setCancelId(null);
      await queryClient.invalidateQueries({ queryKey: ['merchant-orders'] });
      await queryClient.invalidateQueries({ queryKey: ['merchant-dashboard'] });
    },
  });

  if (orders.isPending) {
    return <StatusView title="Đang tải đơn của quán…" />;
  }
  if (orders.isError) {
    return <StatusView title="Chưa tải được đơn" message="Vui lòng kiểm tra kết nối và thử lại." action={{ label: 'Thử lại', onClick: () => { void orders.refetch(); } }} />;
  }
  const list = orders.data.data;
  if (list.length === 0) {
    return <StatusView title="Quán chưa có đơn nào" message="Bấm “Sẵn sàng thu gom” ở trang chủ khi can đã đầy nhé." />;
  }

  return (
    <div className="page-content">
      <header className="page-header"><div><p className="eyebrow">QUẢN LÝ</p><h1>Đơn của tôi</h1></div></header>
      <section className="orders-list">
        {list.map((order) => {
          const canCancel = order.status === OrderStatus.READY;
          return (
            <article className="order-card" key={order.id}>
              <div className="order-card-top"><strong>{order.container_code ?? 'Chưa gắn can'}</strong><span className={`order-status order-${order.status.toLowerCase()}`}>{statusLabel(order.status)}</span></div>
              <p>{formatLiters(order.expected_liters)} · Báo lúc {formatDate(order.requested_at)}</p>
              {canCancel ? <button className="text-button" onClick={() => setCancelId(order.id)}>Huỷ đơn</button> : null}
            </article>
          );
        })}
      </section>
      {cancelId ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
            <h2 id="cancel-title">Huỷ yêu cầu thu gom?</h2>
            <p>Đơn này sẽ chuyển sang trạng thái đã huỷ. Bạn có chắc muốn tiếp tục?</p>
            <div className="sheet-actions">
              <button className="secondary-button" onClick={() => setCancelId(null)} disabled={cancelOrder.isPending}>Để lại</button>
              <button className="danger-button" onClick={() => void cancelOrder.mutateAsync(cancelId)} disabled={cancelOrder.isPending}>{cancelOrder.isPending ? 'Đang huỷ…' : 'Huỷ đơn'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.READY:
      return 'Đang chờ';
    case OrderStatus.ASSIGNED:
      return 'Đã phân công';
    case OrderStatus.COLLECTED:
      return 'Đã thu gom';
    case OrderStatus.CANCELLED:
      return 'Đã huỷ';
  }
}
