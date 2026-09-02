'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  const { user, loading, error, loginAdmin } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [loading, router, user]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink p-5">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
        <img src="/logo.svg" alt="ECOllect" className="h-20 w-20" />
        <p className="mt-4 text-sm font-bold uppercase tracking-[0.25em] text-emerald-700">
          ECOllect
        </p>
        <h1 className="mt-3 text-3xl font-bold text-ink">Bảng vận hành</h1>
        <p className="mt-3 text-slate-600">Đăng nhập bằng tài khoản và mật khẩu quản trị.</p>
        <label className="mt-6 block text-sm font-semibold text-slate-700">
          Mật khẩu
          <input
            className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 px-3"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button
          className="mt-5 min-h-12 w-full rounded-xl bg-emerald-700 px-4 font-bold text-white hover:bg-emerald-800 disabled:opacity-60"
          disabled={loading || !password}
          onClick={() => void loginAdmin(password)}
        >
          {loading ? 'Đang đăng nhập…' : 'Đăng nhập quản trị'}
        </button>
        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <p className="mt-5 text-xs text-slate-400">
          Tài khoản: {process.env.NEXT_PUBLIC_ADMIN_ZALO_ID ?? 'zalo_admin_01'}
        </p>
      </section>
    </main>
  );
}
