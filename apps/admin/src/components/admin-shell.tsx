'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { isAdminUser } from '../lib/dashboard-utils';
import { Skeleton } from './ui';

const links = [
  ['/', 'Tổng quan'],
  ['/reconciliation', 'Đối soát'],
  ['/alerts', 'Cảnh báo'],
  ['/stations', 'Trạm'],
  ['/merchants', 'Quán'],
  ['/collectors', 'Người thu gom'],
];

export function AdminShell({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !isAdminUser(user)) router.replace('/login');
  }, [loading, router, user]);

  if (loading || !user || user.role !== 'ADMIN') return <main className="p-8"><Skeleton className="h-10 w-64" /><Skeleton className="mt-6 h-40 w-full" /></main>;
  const adminUser = user;

  return <div className="min-h-screen bg-sand text-ink md:flex">
    <aside className="w-full border-b border-slate-200 bg-ink p-4 text-white md:min-h-screen md:w-64 md:border-b-0 md:p-5">
      <div className="mb-6"><p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Eco-Oil</p><h1 className="mt-1 text-xl font-bold">Vận hành</h1></div>
      <nav className="grid grid-cols-2 gap-2 md:block md:space-y-1">{links.map(([href, label]) => <Link key={href} href={href} className={`block rounded-xl px-3 py-2.5 text-sm transition ${pathname === href ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'}`}>{label}</Link>)}</nav>
    </aside>
    <div className="min-w-0 flex-1">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4 md:px-8"><div><p className="text-xs uppercase tracking-widest text-slate-400">Bảng điều hành</p><p className="font-semibold">Xin chào, {adminUser.name ?? 'Quản trị viên'}</p></div><button className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold hover:bg-slate-50" onClick={() => { void signOut().then(() => router.replace('/login')); }}>Đăng xuất</button></header>
      <main className="mx-auto max-w-7xl p-5 md:p-8">{children}</main>
    </div>
  </div>;
}
