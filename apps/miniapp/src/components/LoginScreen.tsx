import { useEffect, useState } from 'react';
import { Role } from '@eco-oil/shared-types';
import type { AdminWardSummary, DevAccount } from '@eco-oil/shared-types';
import { ApiError, api } from '../lib/api';
import { zaloClient } from '../lib/zalo-client';
import { useAuthStore } from '../stores/auth-store';
import { getSeedLoginCredentials, shouldShowDevelopmentLogin } from './login-screen-logic';

export function LoginScreen() {
  const [selectedId, setSelectedId] = useState('');
  const [devAccounts, setDevAccounts] = useState<DevAccount[]>([]);
  const [devAccountsError, setDevAccountsError] = useState<string | null>(null);
  const [backendMockDetected, setBackendMockDetected] = useState(false);
  const [sdkUnavailable, setSdkUnavailable] = useState(zaloClient.mode === 'mock');
  const busy = useAuthStore((state) => state.busy);
  const error = useAuthStore((state) => state.error);
  const loginSeed = useAuthStore((state) => state.loginSeed);
  const loginWithZalo = useAuthStore((state) => state.loginWithZalo);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerForm, setRegisterForm] = useState({ zalo_id: 'zalo_merchant_new_01', name: '', address: '', phone: '', business_type: 'Quán ăn', lat: null as number | null, lng: null as number | null, ward_id: '' });
  const [wards, setWards] = useState<AdminWardSummary[]>([]);
  const [wardLoadError, setWardLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.devAccounts().then((items) => {
      if (!active) return;
      setBackendMockDetected(true);
      setDevAccounts(items);
      setSelectedId((current) => current || items[0]?.zalo_id || '');
    }).catch((reason) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) {
        setBackendMockDetected(false);
        setDevAccountsError(null);
        return;
      }
      setDevAccountsError(reason instanceof Error ? reason.message : 'Không tải được tài khoản thử nghiệm.');
    });
    return () => { active = false; };
  }, []);

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
    const credentials = getSeedLoginCredentials(devAccounts, selectedId);
    const account = devAccounts.find((item) => item.zalo_id === selectedId);
    if (!credentials || !account) return;
    zaloClient.setSeedAccount({ zaloId: credentials.zaloId, phone: credentials.phone, name: account.name ?? undefined });
    await loginSeed(credentials.zaloId, credentials.phone);
  }

  async function handleRegister() {
    setRegisterError(null);
    try {
      const point = await zaloClient.getLocation();
      if (!point) throw new Error('Không lấy được vị trí GPS. Vui lòng bật quyền vị trí rồi thử lại.');
      await api.registerMerchant({ ...registerForm, lat: point.lat, lng: point.lng });
      await loginSeed(registerForm.zalo_id, registerForm.phone);
    } catch (reason) {
      setRegisterError(reason instanceof Error ? reason.message : 'Đăng ký thất bại. Vui lòng kiểm tra lại thông tin.');
    }
  }

  const roleGroups = [Role.MERCHANT, Role.COLLECTOR, Role.ADMIN] as const;

  return (
    <main className="login-page">
      <img className="login-logo" src="/logo.svg" alt="Eco-Oil" />
      <p className="eyebrow">ECO-OIL</p>
      <h1>Thu gom dầu dễ dàng</h1>
      <p className="lead">Đăng nhập để báo can sẵn sàng và theo dõi lịch sử thu gom của quán.</p>
      <button className="primary-button" onClick={() => void handleZaloLogin()} disabled={busy || backendMockDetected}>{backendMockDetected ? 'Chọn tài khoản thử nghiệm để tiếp tục' : busy ? 'Đang đăng nhập…' : 'Đăng nhập bằng Zalo'}</button>
      {backendMockDetected ? <p className="error-text">Backend đang ở môi trường phát triển. Chọn tài khoản thử nghiệm để tiếp tục.</p> : null}
      {shouldShowDevelopmentLogin(backendMockDetected, sdkUnavailable) ? (
        <section className="dev-login-card">
          <p className="section-label">Môi trường phát triển</p>
          <label htmlFor="seed-account">Chọn tài khoản thử nghiệm</label>
          <select id="seed-account" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={devAccounts.length === 0}>
            {roleGroups.map((role) => {
              const accounts = devAccounts.filter((account) => account.role === role);
              if (accounts.length === 0) return null;
              const groupLabel = role === Role.MERCHANT ? 'Quán' : role === Role.COLLECTOR ? 'Người thu gom' : 'Admin';
              return <optgroup label={groupLabel} key={role}>{accounts.map((account) => <option value={account.zalo_id} key={account.zalo_id}>{account.name ?? account.zalo_id}{account.role === Role.COLLECTOR && account.wards.length > 0 ? ` — ${account.wards.map((ward) => ward.name).join(', ')}` : ''} ({account.zalo_id})</option>)}</optgroup>;
            })}
          </select>
          {devAccountsError ? <p className="error-text">{devAccountsError}</p> : null}
          <button className="secondary-button" onClick={() => void handleSeedLogin()} disabled={busy || !selectedId}>Vào bản thử nghiệm</button>
        </section>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <button className="text-button" onClick={() => setRegistering(!registering)}>{registering ? 'Quay lại đăng nhập' : 'Đăng ký quán mới'}</button>
      {registering && <section className="dev-login-card approval-form"><p className="section-label">Đăng ký quán</p><label>Mã Zalo (bản thử nghiệm)<input value={registerForm.zalo_id} onChange={(event) => setRegisterForm({ ...registerForm, zalo_id: event.target.value })} /></label><label>Tên quán<input value={registerForm.name} onChange={(event) => setRegisterForm({ ...registerForm, name: event.target.value })} /></label><label>Địa chỉ<input value={registerForm.address} onChange={(event) => setRegisterForm({ ...registerForm, address: event.target.value })} /></label><label>Số điện thoại<input value={registerForm.phone} onChange={(event) => setRegisterForm({ ...registerForm, phone: event.target.value })} /></label><label>Loại hình<input value={registerForm.business_type} onChange={(event) => setRegisterForm({ ...registerForm, business_type: event.target.value })} /></label>{wardLoadError ? <p className="error-text">{wardLoadError}</p> : wards.length > 1 ? <label>Phường đăng ký<select value={registerForm.ward_id} onChange={(event) => setRegisterForm({ ...registerForm, ward_id: event.target.value })}><option value="">Chọn phường</option>{wards.map((ward) => <option key={ward.id} value={ward.id}>{ward.name}, {ward.district} ({ward.code})</option>)}</select></label> : wards.length === 1 ? <p className="section-label">Địa bàn: {wards[0].name}, {wards[0].district}</p> : null}<button className="primary-button" onClick={() => void handleRegister()} disabled={busy || !registerForm.ward_id}>Gửi hồ sơ đăng ký</button>{registerError && <p className="error-text">{registerError}</p>}</section>}
    </main>
  );
}
