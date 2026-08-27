# Eco-Oil demo deployment

Tài liệu này chuẩn bị cho bản demo chạy trên trình duyệt. Chưa bao gồm đóng gói Zalo Mini App.

Quy trình bật relay GPS, cập nhật Render, mở QR Development và thứ tự trình diễn được ghi tại [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md).

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
| `ZALO_APP_ID` | ID ứng dụng Zalo | Có khi `ZALO_AUTH_MODE=real` | Chỉ đặt ở API/server |
| `ZALO_APP_SECRET` | secret key của ứng dụng Zalo | Có khi `ZALO_AUTH_MODE=real` | Chỉ đặt ở API/server, không đưa vào frontend |
| `ZALO_OAUTH_CALLBACK_URL` | `https://eco-oil-api.onrender.com/api/v1/auth/zalo/callback` | Có khi OAuth web | Phải khớp Callback URL trong Zalo for Developers |
| `ZALO_OAUTH_SUCCESS_REDIRECT_URL` | `https://uco-platform-miniapp.vercel.app/` | Có khi OAuth web | URL frontend nhận phiên đã xác thực qua HttpOnly cookie |
| `CORS_ORIGINS` | `https://uco-platform-miniapp.vercel.app,https://uco-platform-admin.vercel.app` | Có khi gọi cross-origin | Danh sách origin phân cách bằng dấu phẩy |
| `REDIS_URL` | `redis://host:6379` | Không | Bỏ trống được; các tính năng phụ thuộc Redis sẽ tắt, API vẫn chạy |
| `GEO_MISMATCH_THRESHOLD_M` | `500` | Không | Ngưỡng cảnh báo GPS |
| `DELIVERY_VARIANCE_THRESHOLD_PCT` | `0.02` | Không | Ngưỡng lệch nộp trạm |

### Mini App trình duyệt

| Biến | Ví dụ | Bắt buộc |
|---|---|---:|
| `VITE_API_BASE_URL` | `https://eco-oil-api.onrender.com/api/v1` | Có |
| `VITE_DEMO_MODE` | `false` | Không |
| `VITE_ESTIMATED_PRICE_PER_LITER` | `8000` | Không |

Khi chạy local, có thể dùng `/api/v1` cùng Vite proxy. Trên Vercel phải đặt URL đầy đủ tới Render API; không dùng localhost, `example.com` hoặc URL tương đối. `VITE_DEMO_MODE` phải là `false` hoặc bỏ trống trên production; khung tài khoản thử nghiệm chỉ xuất hiện khi bật rõ ràng và API trả về tài khoản.

### Admin Next.js

| Biến | Ví dụ | Bắt buộc |
|---|---|---:|
| `NEXT_PUBLIC_API_BASE_URL` | `https://eco-oil-api.onrender.com/api/v1` | Có |
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

- ## Triển khai cloud (cấu hình đang chạy thật)

Bản demo đang chạy trên: Neon (PostgreSQL + PostGIS), Upstash (Redis),
Render (API), Vercel (Mini App + Admin). Toàn bộ ở Singapore.

### Render — service API

Build Command:
```
pnpm install --frozen-lockfile && pnpm --filter api exec prisma generate --schema=../../prisma/schema.prisma && pnpm --filter "api..." build
```

Start Command:

```
node apps/api/dist/main.js
```

Ba điểm bắt buộc, mỗi điểm đều từng làm deploy chết:

- `--filter "api..."` có ba dấu chấm, để build cả package phụ thuộc
  (`@eco-oil/validation`, `@eco-oil/shared-types`). Thiếu ba chấm thì lỗi
  `TS2307: Cannot find module '@eco-oil/validation'`.
- `--schema=../../prisma/schema.prisma` vì schema nằm ở gốc repo, không nằm
  trong `apps/api`.
- **Không set biến `PORT`.** Render tự cấp cổng; set tay thì báo
  "No open ports detected" rồi kill service.
- Start Command **không được** chứa `prisma migrate deploy`. Chuỗi kết nối
  Neon là dạng pooled, không xin được advisory lock của Prisma, nên migration
  timeout `P1002` và server chết trong vòng lặp restart.

Biến môi trường trên Render: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`ADMIN_PASSWORD`, `CORS_ORIGINS`, `DEMO_MODE`, `NODE_ENV`, `ZALO_AUTH_MODE`,
`ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OAUTH_CALLBACK_URL`,
`ZALO_OAUTH_SUCCESS_REDIRECT_URL`.

Khi dùng OAuth thật, đặt `ZALO_AUTH_MODE=real`, cấu hình App ID/App Secret ở
Zalo for Developers, bật đúng quyền Social API cần dùng, và đăng ký chính xác
Callback URL. Production không khởi động nếu vẫn để mock.

```
CORS_ORIGINS=https://uco-platform-miniapp.vercel.app,https://uco-platform-admin.vercel.app
```

Không có dấu cách sau dấu phẩy, không có dấu `/` ở cuối. Sau khi sửa biến
phải bấm **Save Changes** rồi F5 lại trang để xác nhận — giá trị hiện đúng
trên màn hình không có nghĩa là đã lưu.

### Vercel — hai project riêng

| Project | Root Directory | Framework |
|---|---|---|
| Mini App | `apps/miniapp` | Vite |
| Admin | `apps/admin` | Next.js |

Root Directory là bắt buộc; trỏ vào gốc repo thì build sai app.

### Quy trình deploy khi có migration mới

Render tự deploy mỗi lần push. Nên nếu push trước, code mới sẽ chạy trên
schema cũ và trả lỗi 500. Thứ tự đúng:

```powershell
cd "<đường dẫn repo>"
$env:DATABASE_URL="<chuỗi kết nối Neon>"
pnpm --filter api exec prisma migrate deploy --schema=../../prisma/schema.prisma
# xác nhận "All migrations have been successfully applied", rồi mới push
```

Đóng cửa sổ PowerShell sau khi xong để biến không lẫn vào lần chạy dev sau.
Không để dòng `$env:DATABASE_URL` xuất hiện trong ảnh chụp màn hình.

Bước này chưa tự động. Hướng xử lý lâu dài: thêm `directUrl` vào datasource
Prisma trỏ chuỗi kết nối không pooled, hoặc tạo one-off job trên Render.

### Dữ liệu tham chiếu

`prisma migrate deploy` chỉ tạo cấu trúc, **không chạy seed**. Sau lần
migrate đầu tiên trên database trống phải tự nhập dữ liệu tham chiếu, ít
nhất là bảng `oil_prices` — thiếu giá thì chốt kỳ ném `NO_PRICE_CONFIGURED`.

### Lưu ý khi demo

Render gói Free ngủ khi không có request; lần gọi đầu mất khoảng 50 giây.
Gọi trước `GET /api/v1/health` vài phút trước khi trình diễn.
