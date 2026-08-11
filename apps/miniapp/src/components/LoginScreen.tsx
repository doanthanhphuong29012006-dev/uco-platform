import { useState } from 'react';
import { zaloClient } from '../lib/zalo-client';
import { useAuthStore } from '../stores/auth-store';

const seedAccounts = [
  { zaloId: 'zalo_merchant_01', phone: '0900000001', label: 'Quán Cơm Nhà Mình' },
  { zaloId: 'zalo_merchant_02', phone: '0900000002', label: 'Bếp Xanh Vegetarian' },
  { zaloId: 'zalo_merchant_03', phone: '0900000003', label: 'Phở Sài Gòn 1975' },
  { zaloId: 'zalo_merchant_04', phone: '0900000004', label: 'Bún Bò Huế Mạ Tôi' },
  { zaloId: 'zalo_merchant_05', phone: '0900000005', label: 'Cơm Tấm Góc Phố' },
  { zaloId: 'zalo_collector_01', phone: '0910000001', label: 'Người thu gom 01' },
] as const;

export function LoginScreen() {
  const [selectedId, setSelectedId] = useState<string>(seedAccounts[0].zaloId);
  const [sdkUnavailable, setSdkUnavailable] = useState(import.meta.env.DEV);
  const busy = useAuthStore((state) => state.busy);
  const error = useAuthStore((state) => state.error);
  const loginSeed = useAuthStore((state) => state.loginSeed);
  const loginWithZalo = useAuthStore((state) => state.loginWithZalo);

  async function handleZaloLogin() {
    try {
      const accessToken = await zaloClient.getAccessToken();
      await loginWithZalo(accessToken);
    } catch {
      setSdkUnavailable(true);
    }
  }

  async function handleSeedLogin() {
    const account = seedAccounts.find((item) => item.zaloId === selectedId) ?? seedAccounts[0];
    await loginSeed(account.zaloId, account.phone);
  }

  return (
    <main className="login-page">
      <div className="brand-mark">E</div>
      <p className="eyebrow">ECO-OIL</p>
      <h1>Thu gom dầu dễ dàng</h1>
      <p className="lead">Đăng nhập để báo can sẵn sàng và theo dõi lịch sử thu gom của quán.</p>
      <button className="primary-button" onClick={handleZaloLogin} disabled={busy}>
        {busy ? 'Đang đăng nhập…' : 'Đăng nhập bằng Zalo'}
      </button>
      {sdkUnavailable ? (
        <section className="dev-login-card">
          <p className="section-label">Môi trường phát triển</p>
          <label htmlFor="seed-account">Chọn tài khoản thử nghiệm</label>
          <select id="seed-account" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {seedAccounts.map((account) => (
              <option value={account.zaloId} key={account.zaloId}>
                {account.label} ({account.zaloId})
              </option>
            ))}
          </select>
          <button className="secondary-button" onClick={handleSeedLogin} disabled={busy}>
            Vào bản thử nghiệm
          </button>
        </section>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </main>
  );
}
