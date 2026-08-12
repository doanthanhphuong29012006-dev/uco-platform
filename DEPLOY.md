# Eco-Oil demo deployment

Tài liệu này chuẩn bị cho bản demo chạy trên trình duyệt. Chưa bao gồm đóng gói Zalo Mini App.

## Biến môi trường

### API

| Biến | Ví dụ | Bắt buộc | Ghi chú |
|---|---|---:|---|
| `NODE_ENV` | `production` | Không | Môi trường chạy |
| `PORT` | `3000` | Không | Mặc định 3000; API lắng nghe `0.0.0.0` |
| `DATABASE_URL` | `postgresql://user:password@host:5432/uco?sslmode=require` | Có | Prisma/PostgreSQL; giữ `sslmode=require` với Neon/Supabase |
| `JWT_SECRET` | chuỗi ngẫu nhiên dài | Có | API crash ngay nếu thiếu hoặc rỗng |
| `ADMIN_PASSWORD` | mật khẩu mạnh | Có cho Admin | Không đặt trong source hoặc frontend |
| `DEMO_MODE` | `true` | Không | Khi `true`, dev accounts chỉ có MERCHANT/COLLECTOR; Admin dùng mật khẩu |
| `ZALO_AUTH_MODE` | `real` hoặc `mock` | Không | `mock` chỉ dùng cho local/demo kiểm thử |
| `CORS_ORIGINS` | `https://demo.example.com,https://admin.demo.example.com` | Có khi gọi cross-origin | Danh sách origin phân cách bằng dấu phẩy |
| `REDIS_URL` | `redis://host:6379` | Không | Bỏ trống được; các tính năng phụ thuộc Redis sẽ tắt, API vẫn chạy |
| `GEO_MISMATCH_THRESHOLD_M` | `500` | Không | Ngưỡng cảnh báo GPS |
| `DELIVERY_VARIANCE_THRESHOLD_PCT` | `0.02` | Không | Ngưỡng lệch nộp trạm |

### Mini App trình duyệt

| Biến | Ví dụ | Bắt buộc |
|---|---|---:|
| `VITE_API_BASE_URL` | `https://api.demo.example.com/api/v1` | Có |
| `VITE_ESTIMATED_PRICE_PER_LITER` | `8000` | Không |

Khi chạy local, có thể dùng `/api/v1` cùng Vite proxy. Khi deploy, đặt URL đầy đủ tới API.

### Admin Next.js

| Biến | Ví dụ | Bắt buộc |
|---|---|---:|
| `NEXT_PUBLIC_API_BASE_URL` | `https://api.demo.example.com/api/v1` | Có |
| `NEXT_PUBLIC_ADMIN_ZALO_ID` | `zalo_admin_01` | Có |
| `NEXT_PUBLIC_ADMIN_PHONE` | `0900000000` | Có |

`ADMIN_PASSWORD` chỉ được đặt ở API/server, không đặt `NEXT_PUBLIC_` và không đưa vào bundle trình duyệt.

## Thứ tự triển khai

```powershell
pnpm install
pnpm generate
pnpm prisma:migrate
pnpm seed:demo
```

Luôn chạy migration trước, sau đó mới chạy seed. `seed:demo` dùng ID cố định và `upsert`, có thể chạy nhiều lần mà không nhân bản dữ liệu.

## Build và start

```powershell
# API
pnpm --filter @eco-oil/api build
pnpm --filter @eco-oil/api start

# Mini App
pnpm --filter @eco-oil/miniapp build
pnpm --filter @eco-oil/miniapp exec vite preview --host 0.0.0.0 --port 5173

# Admin
pnpm --filter @eco-oil/admin build
pnpm --filter @eco-oil/admin start
```

Có thể build toàn workspace bằng `pnpm build`.

## Tài khoản demo

Mini App dùng các tài khoản `zalo_demo_merchant_01` đến `zalo_demo_merchant_05` và `zalo_demo_collector_01`, `zalo_demo_collector_02` khi bật mock. Admin không xuất hiện trong `/auth/dev-accounts`; Admin đăng nhập tại Admin bằng `NEXT_PUBLIC_ADMIN_ZALO_ID`, số điện thoại tương ứng và `ADMIN_PASSWORD` cấu hình ở API.

## Bảo mật

- Không commit `.env`, mật khẩu, JWT secret hoặc connection string có password.
- `JWT_SECRET` không có fallback trong code.
- `DEMO_MODE=true` chặn Admin qua đường `/auth/zalo` và `/auth/dev-accounts` không trả Admin.
- Redis là tùy chọn; PostgreSQL vẫn bắt buộc.
