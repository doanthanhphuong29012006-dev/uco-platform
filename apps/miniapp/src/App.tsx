import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Role } from '@eco-oil/shared-types';
import { useAuthStore } from './stores/auth-store';
import { ApiError } from './lib/api';
import { captureCollectorInvite, clearStoredCollectorInvite, getStoredCollectorInvite } from './lib/collector-invite';
import { LoginScreen } from './components/LoginScreen';
import { HomePage } from './pages/HomePage';
import { HistoryPage } from './pages/HistoryPage';
import { OrdersPage } from './pages/OrdersPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { CollectorFlow } from './pages/CollectorFlow';
import { StatusView } from './components/StatusView';
import { MerchantApprovalView } from './components/MerchantApprovalView';
import { startOutboxSyncWorker } from './lib/outbox-sync';
import { useOutboxStats } from './lib/outbox-hooks';

type Tab = 'home' | 'history' | 'orders' | 'payments';

function BrandHeader({ title, action }: { title: string; action?: ReactNode }) {
  return <header className="brand-header"><img src="/logo.svg" alt="ECollect" /><div className="brand-header-copy"><strong>ECollect</strong><span>{title}</span></div>{action}</header>;
}

export function App() {
  const user = useAuthStore((state) => state.user);
  const hydrated = useAuthStore((state) => state.hydrated);
  const hydrate = useAuthStore((state) => state.hydrate);
  const acceptCollectorInvite = useAuthStore((state) => state.acceptCollectorInvite);
  const signOut = useAuthStore((state) => state.signOut);
  const outboxStats = useOutboxStats();
  const [tab, setTab] = useState<Tab>('home');
  const [collectorInviteError, setCollectorInviteError] = useState<string | null>(null);
  const [collectorInviteRetry, setCollectorInviteRetry] = useState(0);

  useEffect(() => {
    captureCollectorInvite();
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !user) return undefined;
    const code = getStoredCollectorInvite();
    if (!code) return undefined;
    let active = true;
    void acceptCollectorInvite(code).then(() => {
      if (!active) return;
      clearStoredCollectorInvite();
      setCollectorInviteError(null);
    }).catch((error) => {
      if (!active) return;
      if (error instanceof ApiError && ['COLLECTOR_INVITE_INVALID', 'COLLECTOR_INVITE_ALREADY_USED', 'COLLECTOR_INVITE_ROLE_CONFLICT', 'USER_ALREADY_LINKED_COLLECTOR', 'COLLECTOR_LOCKED'].includes(error.code)) {
        clearStoredCollectorInvite();
      }
      setCollectorInviteError(error instanceof ApiError ? error.message : 'Không thể liên kết lời mời người thu gom.');
    });
    return () => { active = false; };
  }, [acceptCollectorInvite, collectorInviteRetry, hydrated, user?.id]);

  useEffect(() => {
    if (user?.role !== Role.COLLECTOR) return undefined;
    return startOutboxSyncWorker();
  }, [user?.role]);

  if (!hydrated) return <div className="app-loading"><img src="/logo.svg" alt="" /><strong>ECollect</strong><span>Đang chuẩn bị ứng dụng…</span></div>;
  if (!user) return <LoginScreen />;

  if (collectorInviteError) {
    return <StatusView title="Không thể liên kết lời mời" message={collectorInviteError} action={{ label: 'Thử lại', onClick: () => { setCollectorInviteError(null); setCollectorInviteRetry((attempt) => attempt + 1); } }} />;
  }

  if (user.role === Role.COLLECTOR) {
    async function handleCollectorSignOut(): Promise<void> {
      const unsynced = outboxStats.pending + outboxStats.syncing + outboxStats.failed;
      if (unsynced > 0 && !window.confirm(`Còn ${unsynced} giao dịch chưa đồng bộ. Bạn có chắc muốn thoát? Dữ liệu vẫn được giữ an toàn trong hàng chờ trên máy.`)) return;
      // Deliberately keep IndexedDB outbox rows; logout only clears auth state and tokens.
      await signOut();
    }
    return <div className="app-shell"><BrandHeader title="Tuyến hôm nay" action={<button className="header-signout" onClick={() => void handleCollectorSignOut()}>Thoát</button>} /><main className="main-area"><CollectorFlow key={user.id} /></main></div>;
  }

  if (user.role !== Role.MERCHANT) {
    return <StatusView title="Vai trò chưa được hỗ trợ" message="Tài khoản này chưa có giao diện trong ứng dụng." action={{ label: 'Đăng xuất', onClick: () => { void signOut(); } }} />;
  }

  if (user.merchantApprovalStatus !== 'APPROVED') return <MerchantApprovalView user={user} />;

  return <div className="app-shell">
    <BrandHeader title={tab === 'home' ? 'Trang chủ' : tab === 'orders' ? 'Đơn của tôi' : tab === 'payments' ? 'Thanh toán' : 'Lịch sử'} />
    <main className="main-area">
      {tab === 'home' ? <HomePage key={user.id} /> : null}
      {tab === 'history' ? <HistoryPage key={user.id} /> : null}
      {tab === 'orders' ? <OrdersPage key={user.id} /> : null}
      {tab === 'payments' ? <PaymentsPage key={user.id} /> : null}
    </main>
    <nav className="bottom-nav" aria-label="Điều hướng chính">
      <button className={tab === 'home' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('home')}><small>Trang chủ</small></button>
      <button className={tab === 'orders' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('orders')}><small>Đơn</small></button>
      <button className={tab === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('history')}><small>Lịch sử</small></button>
      <button className={tab === 'payments' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('payments')}><small>Thanh toán</small></button>
      <button className="nav-item" onClick={() => { void signOut(); }}><small>Đăng xuất</small></button>
    </nav>
  </div>;
}
