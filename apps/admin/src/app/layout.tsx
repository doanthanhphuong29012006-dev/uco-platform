import type { Metadata } from 'next';
import { Providers } from '../components/providers';
import './globals.css';
export const metadata: Metadata = {
  title: 'ECOllect',
  description: 'Bảng vận hành thu gom dầu ăn đã qua sử dụng',
  icons: { icon: '/logo.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
