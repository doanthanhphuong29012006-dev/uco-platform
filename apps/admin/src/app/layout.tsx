import type { Metadata } from 'next';
import { Providers } from '../components/providers';
import './globals.css';

export const metadata: Metadata = { title: 'Eco-Oil | Vận hành', description: 'Bảng điều hành thu gom dầu ăn đã qua sử dụng' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body><Providers>{children}</Providers></body></html>;
}
