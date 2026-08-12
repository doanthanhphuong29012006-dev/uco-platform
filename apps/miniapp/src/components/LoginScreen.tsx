import { useEffect, useState } from 'react';
import type { AdminWardSummary } from '@eco-oil/shared-types';
import { api } from '../lib/api';
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
  const [sdkUnavailable, setSdkUnavailable] = useState(zaloClient.mode === 'mock');
  const busy = useAuthStore((state) => state.busy);
  const error = useAuthStore((state) => state.error);
  const loginSeed = useAuthStore((state) => state.loginSeed);
  const loginWithZalo = useAuthStore((state) => state.loginWithZalo);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerForm, setRegisterForm] = useState({ zalo_id: 'zalo_merchant_new_01', name: '', address: '', phone: '', business_type: 'Quán ăn', lat: 10.7818, lng: 106.6851, ward_id: '' });
  const [wards, setWards] = useState<AdminWardSummary[]>([]);
  const [wardLoadError, setWardLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!registering) return;
    void api.registrationWards().then((items) => {
      setWards(items);
      setRegisterForm((current) => current.ward_id || items.length !== 1 ? current : { ...current, ward_id: items[0].id });
    }).catch(() => setWardLoadError('Không tải được danh sách phường. Vui lòng thử lại.'));
  }, [registering]);

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
    zaloClient.setSeedAccount(account);
    const identity = await zaloClient.login();
    await loginSeed(identity.zaloId, identity.phone);
  }

  async function handleRegister() {
    setRegisterError(null);
    try {
      const point = await zaloClient.getLocation();
      await api.registerMerchant({ ...registerForm, lat: point.lat, lng: point.lng });
      await loginSeed(registerForm.zalo_id, registerForm.phone);
    } catch (error) {
      setRegisterError(error instanceof Error ? error.message : 'Đăng ký thất bại. Vui lòng kiểm tra lại thông tin.');
    }
  }

  return (
    <main className="login-page">
      <img className="login-logo" src="/logo.svg" alt="Eco-Oil" />
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
      <button className="text-button" onClick={() => setRegistering(!registering)}>{registering ? 'Quay lại đăng nhập' : 'Đăng ký quán mới'}</button>
      {registering && <section className="dev-login-card approval-form"><p className="section-label">Đăng ký quán</p><label>Mã Zalo (bản thử nghiệm)<input value={registerForm.zalo_id} onChange={(e) => setRegisterForm({ ...registerForm, zalo_id: e.target.value })} /></label><label>Tên quán<input value={registerForm.name} onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })} /></label><label>Địa chỉ<input value={registerForm.address} onChange={(e) => setRegisterForm({ ...registerForm, address: e.target.value })} /></label><label>Số điện thoại<input value={registerForm.phone} onChange={(e) => setRegisterForm({ ...registerForm, phone: e.target.value })} /></label><label>Loại hình<input value={registerForm.business_type} onChange={(e) => setRegisterForm({ ...registerForm, business_type: e.target.value })} /></label>{wardLoadError ? <p className="error-text">{wardLoadError}</p> : wards.length > 1 ? <label>Phường đăng ký<select value={registerForm.ward_id} onChange={(e) => setRegisterForm({ ...registerForm, ward_id: e.target.value })}><option value="">Chọn phường</option>{wards.map((ward) => <option key={ward.id} value={ward.id}>{ward.name}, {ward.district} ({ward.code})</option>)}</select></label> : wards.length === 1 ? <p className="section-label">Địa bàn: {wards[0].name}, {wards[0].district}</p> : null}<button className="primary-button" onClick={() => void handleRegister()} disabled={busy || !registerForm.ward_id}>Gửi hồ sơ đăng ký</button>{registerError && <p className="error-text">{registerError}</p>}</section>}
    </main>
  );
}
