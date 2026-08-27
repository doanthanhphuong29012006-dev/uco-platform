# Eco-Oil UCO Platform

Backend MVP cho thí điểm thu gom dầu ăn đã qua sử dụng (UCO): quán đăng ký yêu cầu, collector lập tuyến và ghi nhận thu gom offline-safe, trạm tiếp nhận, admin đối soát.

## Yêu cầu môi trường

- Node.js 22+
- pnpm 11+
- Docker Desktop với Docker Compose
- Git

Stack chính: NestJS + TypeScript, PostgreSQL 16/PostGIS, Prisma, Redis, Jest/Supertest và Turborepo.

## Chạy local từ zero

```bash
git clone <repository-url>
cd uco-platform
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Trên PowerShell, lệnh copy env tương đương là:

```powershell
Copy-Item .env.example .env
```

API chạy tại `http://127.0.0.1:3000`, health check tại `/api/v1/health`. PostgreSQL được map ra `5433` để tránh xung đột với project khác; Redis dùng `6379`.

Để dọn database local và tạo lại từ migration:

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

## Tài khoản seed

Mock Zalo login dùng `zalo_id` và `phone`; không cần Zalo OAuth thật trong MVP.

| zalo_id | phone | role |
|---|---|---|
| `zalo_admin_01` | `0990000001` | ADMIN |
| `zalo_merchant_01` … `zalo_merchant_05` | `0900000001` … `0900000005` | MERCHANT |
| `zalo_collector_01` | `0910000001` | COLLECTOR |
| `zalo_collector_02` | `0910000002` | COLLECTOR |
| `zalo_station_01` | `0920000001` | STATION |

Ví dụ login và gọi API:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/auth/zalo \
  -H 'Content-Type: application/json' \
  -d '{"zalo_id":"zalo_merchant_01","phone":"0900000001"}'

curl -s http://127.0.0.1:3000/api/v1/auth/me \
  -H 'Authorization: Bearer <access_token>'
```

## API và RBAC

Tất cả API route dưới đây có prefix `/api/v1`. File xác thực domain Zalo là route public duy nhất ở root domain. Các route authenticated đều đi qua JWT guard; role được kiểm tra bởi RolesGuard.

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/health` | PUBLIC |
| POST | `/auth/zalo` | PUBLIC |
| POST | `/auth/refresh` | PUBLIC |
| POST | `/auth/logout` | MERCHANT, COLLECTOR, STATION, ADMIN |
| GET | `/auth/me` | MERCHANT, COLLECTOR, STATION, ADMIN |
| GET | `/auth/admin-check` | ADMIN |
| POST | `/merchants/register` | MERCHANT |
| GET | `/merchants/me/dashboard` | MERCHANT, ADMIN |
| GET | `/merchants/me` | MERCHANT, ADMIN |
| PATCH | `/merchants/:id` | MERCHANT, ADMIN |
| PATCH | `/merchants/:id/status` | MERCHANT, ADMIN |
| GET | `/merchants` | ADMIN |
| POST | `/collectors` | ADMIN |
| GET | `/collectors` | ADMIN |
| GET | `/collectors/:id` | ADMIN |
| PATCH | `/collectors/:id` | ADMIN |
| PATCH | `/collectors/:id/status` | ADMIN |
| POST | `/stations` | ADMIN |
| GET | `/stations` | ADMIN |
| GET | `/stations/recommend` | COLLECTOR, ADMIN |
| GET | `/stations/:id` | ADMIN |
| PATCH | `/stations/:id` | ADMIN |
| PATCH | `/stations/:id/status` | ADMIN |
| POST | `/containers` | ADMIN |
| GET | `/containers/by-qr/:code` | COLLECTOR, ADMIN |
| GET | `/containers` | ADMIN |
| PATCH | `/containers/:id/assign` | ADMIN |
| PATCH | `/containers/:id/status` | ADMIN |
| POST | `/orders/ready` | MERCHANT |
| GET | `/orders/me` | MERCHANT |
| POST | `/orders/:id/cancel` | MERCHANT |
| GET | `/routes/current` | COLLECTOR |
| POST | `/collections` | COLLECTOR |
| GET | `/collections/me` | COLLECTOR |
| POST | `/sync/batch` | COLLECTOR |
| POST | `/station-deliveries` | COLLECTOR |
| GET | `/admin/overview` | ADMIN |
| GET | `/admin/reconciliation` | ADMIN |
| GET | `/admin/alerts` | ADMIN |
| PATCH | `/admin/alerts/:id/resolve` | ADMIN |
| GET | `/admin/merchants/:id/performance` | ADMIN |

Có 41 API endpoint path gồm health, tất cả đều nằm dưới `/api/v1`; file xác thực domain Zalo được phục vụ riêng ở root domain.

## Chạy test

Test dùng `.env.test` và database `uco_test`. Cần chạy PostgreSQL/PostGIS và Redis trước:

```bash
docker compose up -d
pnpm prisma:migrate
pnpm db:seed
pnpm test
```

Reset database test sạch trên PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/uco_test'
pnpm prisma migrate reset --force
pnpm db:seed
pnpm test
```

Chạy riêng full-flow trên database sạch và yêu cầu reconciliation không còn giao dịch chưa nộp trạm:

```powershell
$env:DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/uco_test'
$env:FULL_FLOW_CLEAN = '1'
pnpm prisma migrate reset --force
pnpm db:seed
pnpm --dir apps/api test -- --runInBand test/full-flow.e2e-spec.ts
```

Test full-flow mô phỏng: merchant tạo 3 order → collector lấy tuyến/scan/thu gom → retry cùng `client_uuid` → giao trạm → admin đối soát.

## Kiến trúc luồng dữ liệu

```mermaid
flowchart LR
  M[Quán / Merchant] -->|ready order| O[CollectionOrder READY]
  O -->|route priority + PostGIS distance| C[Collector]
  C -->|QR + collection transaction| T[CollectionTransaction]
  T -->|offline sync, idempotency| S[Sync batch]
  T -->|station delivery| D[StationDelivery]
  D --> ST[Station volume]
  T --> R[Admin reconciliation]
  D --> R
```

Mỗi lần thu gom có `client_uuid` duy nhất. Server dùng `INSERT ... ON CONFLICT (client_uuid) DO NOTHING RETURNING` trong transaction; retry trả lại bản ghi cũ và không chạy lại side effect. Cơ chế này cần thiết vì collector có thể mất mạng và gửi lại cùng một giao dịch nhiều lần: nếu không có idempotency, số lít, trạng thái can và đối soát sẽ bị cộng trùng.

Geography được ghi bằng PostGIS geography SRID 4326 và khoảng cách tuyến/khuyến nghị trạm dùng `ST_Distance` theo mét.

## Biến môi trường

Xem `.env.example` cho development và `.env.test` cho e2e. Các biến runtime:

| Variable | Ý nghĩa |
|---|---|
| `NODE_ENV` | `development` hoặc `test` |
| `PORT` | Cổng API |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret ký JWT, cấp qua secret manager ở production |
| `ZALO_AUTH_MODE` | `mock` hoặc `real` |
| `ZALO_APP_ID` | App ID Zalo, chỉ ở backend khi dùng OAuth thật |
| `ZALO_APP_SECRET` | App Secret Zalo, chỉ ở backend và secret manager |
| `ZALO_OAUTH_CALLBACK_URL` | Callback URL đã đăng ký với Zalo |
| `ZALO_OAUTH_SUCCESS_REDIRECT_URL` | URL frontend sau OAuth callback |
| `GEO_MISMATCH_THRESHOLD_M` | Ngưỡng cảnh báo vị trí thu gom |
| `DELIVERY_VARIANCE_THRESHOLD_PCT` | Ngưỡng lệch khi giao trạm |

OAuth thật dùng Zalo Social OAuth v4 + PKCE/state; mock provider chỉ được phép ở development/test.

## CI

GitHub Actions khởi chạy service containers PostgreSQL/PostGIS và Redis, chạy migration, sau đó:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
