import { useEffect, useState } from 'react';
import { Role } from '@eco-oil/shared-types';
import { useAuthStore } from './stores/auth-store';
import { LoginScreen } from './components/LoginScreen';
import { HomePage } from './pages/HomePage';
import { HistoryPage } from './pages/HistoryPage';
import { OrdersPage } from './pages/OrdersPage';
import { CollectorFlow } from './pages/CollectorFlow';
import { StatusView } from './components/StatusView';

type Tab = 'home' | 'history' | 'orders';

export function App() {
  const user = useAuthStore((state) => state.user);
  const hydrated = useAuthStore((state) => state.hydrated);
  const hydrate = useAuthStore((state) => state.hydrate);
  const signOut = useAuthStore((state) => state.signOut);
  const [tab, setTab] = useState<Tab>('home');

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) {
    return <div className="app-loading">Đang mở Eco-Oil…</div>;
  }
  if (!user) {
    return <LoginScreen />;
  }

  if (user.role === Role.COLLECTOR) {
    return <div className="app-shell"><main className="main-area"><CollectorFlow /></main></div>;
  }

  if (user.role !== Role.MERCHANT) {
    return <StatusView title="Vai trò chưa được hỗ trợ" message="Tài khoản này chưa có giao diện trong ứng dụng." action={{ label: 'Đăng xuất', onClick: signOut }} />;
  }

  return (
    <div className="app-shell">
      <main className="main-area">
        {tab === 'home' ? <HomePage /> : null}
        {tab === 'history' ? <HistoryPage /> : null}
        {tab === 'orders' ? <OrdersPage /> : null}
      </main>
      <nav className="bottom-nav" aria-label="Điều hướng chính">
        <button className={tab === 'home' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('home')}><span>⌂</span><small>Trang chủ</small></button>
        <button className={tab === 'orders' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('orders')}><span>▤</span><small>Đơn của tôi</small></button>
        <button className={tab === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('history')}><span>◷</span><small>Lịch sử</small></button>
        <button className="nav-item" onClick={signOut}><span>↪</span><small>Thoát</small></button>
      </nav>
    </div>
  );
}
