import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DEFAULT_DENSITY_KG_PER_LITER } from '@eco-oil/shared-types';
import { api } from '../lib/api';
import { formatDate, formatLiters } from '../lib/formatters';
import { StatusView } from '../components/StatusView';
import { useAuthStore } from '../stores/auth-store';

export function HistoryPage() {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const userId = useAuthStore((state) => state.user?.id ?? 'unknown');
  const history = useInfiniteQuery({
    queryKey: ['merchant-transactions', userId],
    queryFn: ({ pageParam }) => api.transactions(pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.meta.page * lastPage.meta.limit < lastPage.meta.total ? lastPage.meta.page + 1 : undefined,
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !history.hasNextPage) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !history.isFetchingNextPage) {
        void history.fetchNextPage();
      }
    }, { rootMargin: '240px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [history]);

  if (history.isPending) {
    return <StatusView title="Đang tải lịch sử…" />;
  }
  if (history.isError) {
    return <StatusView title="Chưa tải được lịch sử" message="Vui lòng kiểm tra kết nối và thử lại." action={{ label: 'Thử lại', onClick: () => { void history.refetch(); } }} />;
  }
  const transactions = history.data.pages.flatMap((page) => page.data);
  if (transactions.length === 0) {
    return <StatusView title="Chưa có lần thu gom nào" message="Khi dầu được thu gom, lịch sử sẽ hiện ở đây." />;
  }

  return (
    <div className="page-content">
      <header className="page-header"><div><p className="eyebrow">THEO DÕI</p><h1>Lịch sử thu gom</h1></div></header>
      <section className="history-list">
        {transactions.map((transaction) => (
          <article className="history-row" key={transaction.id}>
            <div className="history-date"><strong>{formatDate(transaction.collected_at)}</strong><span>{transaction.container_code}</span></div>
            <div className="history-amount"><strong>{formatLiters(transaction.actual_liters)}</strong><span>{transaction.actual_kg === null ? `~${(transaction.actual_liters * DEFAULT_DENSITY_KG_PER_LITER).toFixed(1)} kg ước lượng` : `${transaction.actual_kg.toFixed(1)} kg đã cân`}</span><span className={`quality quality-${transaction.quality.toLowerCase()}`}>{transaction.quality === 'PASS' ? 'Đạt' : 'Cần kiểm tra'}</span></div>
            <p className="history-collector">Người thu gom: {transaction.collector_name ?? 'Đang cập nhật'}</p>
          </article>
        ))}
      </section>
      <div ref={sentinelRef} className="scroll-sentinel">{history.isFetchingNextPage ? 'Đang tải thêm…' : history.hasNextPage ? ' ' : 'Đã hiển thị hết lịch sử'}</div>
    </div>
  );
}
