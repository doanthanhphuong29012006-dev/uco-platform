# ECOllect — bàn giao sửa luồng thiết bị, ngày 04/09/2026

## Phạm vi và giới hạn

Tiếp tục từ commit có sẵn `fa8426c`, không reset code, không commit/push/deploy. Không chạy seed, migration hoặc ghi dữ liệu production. Prisma Client chỉ được generate cục bộ từ schema mới, không cài lại dependency.

Người dùng báo lỗi lúc **22:48**. Không có order_id/collector_id/route_id, phiên bản Zalo hoặc log production tương ứng; các log cục bộ đã tìm không có mốc này. Không khẳng định đã tái hiện chính xác sự cố trên điện thoại.

## Bằng chứng và sửa đổi

### Tuyến, QR, outbox

- Handler Thu gom chỉ đổi màn hình; QR lookup là GET. Không tìm thấy mutation thu gom trong onClick mở form, unmount hoặc cleanup. Giao dịch chỉ enqueue sau nút xác nhận.
- `reconcileRouteProgress` từng coi dữ liệu `storedCompleted` là xác nhận dù không có outbox hoặc trạng thái server; outbox pending/failed cũng được cộng vào completedOrderIds. Khi outbox chưa hydrate, local marker có thể làm điểm bị ẩn. Đã tách xác nhận server khỏi dữ liệu xác nhận tại máy, giữ thẻ Chờ đồng bộ và không cho mở một giao dịch mới trùng đơn.
- Mở lại mặc định về tuyến, không tự nhảy sang tóm tắt từ local marker. Không dùng userId thay collectorId làm khóa mới.
- Lỗi ghi cache sau khi GET thành công không được thay kết quả server bằng cache cũ/rỗng.
- `currentRoute` vẫn ưu tiên ACTIVE. Nếu có ASSIGNED thuộc Collector nhưng không nằm trong điểm PENDING của ACTIVE, trả lỗi `ASSIGNED_ORDERS_WITHOUT_ACTIVE_ROUTE` kèm ID; không reset/xóa hoặc tự gán lại.
- Chặn replay client_uuid của route thuộc Collector khác. READY preview chỉ lấy quán APPROVED có phường thuộc địa bàn, order chưa được giao.
- Enqueue lại cùng owner/order hoặc bấm đồng thời dùng lại bản ghi/client_uuid đã lưu; retry không tạo bản ghi khác. Backend COLLECTED vẫn chỉ ghi trong transaction thu gom đã kiểm tra quyền, đơn, can và thông tin giao dịch.
- Log mở form/đọc tuyến/xác nhận local chỉ chứa ID, trạng thái và giai đoạn; không chứa token.

### Gọi quán và runtime

Đã kiểm tra package thực tế `zmp-sdk 2.53.0` và tài liệu chính thức:

- [openPhone](https://docs.zaloplatforms.com/docs/MA/api/device/contact/openPhone): API mở màn hình gọi, tham số `phoneNumber`; chấp nhận đầu số quốc tế. Promise resolve không chứng minh cuộc gọi đã kết nối.
- [getLocation](https://docs.zaloplatforms.com/docs/MA/api/location/getLocation): location token dùng một lần, hết hạn sau 2 phút.
- [authorize](https://docs.zaloplatforms.com/docs/MA/api/user/authorization/authorize): kiểm tra getSetting rồi xin scope.userLocation khi cần.

SDK tự cài global ZaloMiniAppSDK khi được import. Nhận diện trước import đã được bổ sung đường dẫn nền tảng `h5.zdn.vn/zapps/` theo appEnv của SDK, không chỉ phụ thuộc global chưa được cài. Không coi website thường trong trình duyệt Zalo là Mini App native chỉ dựa vào user-agent.

SDK gọi điện được chuẩn bị trước thao tác bấm. Handler gọi SDK trước await/import, có timeout. Bỏ tự gọi tel sau SDK thất bại; dùng liên kết **Gọi bằng điện thoại** từ lần bấm mới, giữ sao chép. Không gọi số thật trong test. Số demo đúng định dạng không chứng minh có thuê bao thật.

### GPS và relay

Luồng có giai đoạn sdk-load → permission → access-token → location-result → backend-exchange → complete. Kiểu dữ liệu lấy từ SDK; xử lý thiếu token, tọa độ legacy hợp lệ, lỗi quyền, unsupported SDK và timeout. Không tạo GPS giả cho hồ sơ quán.

Các lần lấy GPS đồng thời dùng chung một operation. Token đã đưa vào đổi không được gửi lại kể cả lần trước lỗi; endpoint đổi vị trí tắt retry/refresh tự động trên 401. Retry chủ động phải xin token mới.

Backend kiểm tra `/health` nhận diện service/version trước khi gửi token. Phân biệt sai dịch vụ, sai đường dẫn, relay auth, mạng/timeout và provider từ chối. Health đúng chưa chứng minh đổi token thành công.

## Cấu hình người dùng cần kiểm tra (chưa thay đổi Render)

Kiểm tra lại cuối lúc khoảng 10:40 ngày 04/09 thấy Profile Relay PID 20576 lắng nghe 8788 và cloudflared PID 10208 trỏ `http://127.0.0.1:8788`. GET /health tại 8788 trả Profile Relay version 2; 8787 không phản hồi, không thấy tiến trình Location Relay. Không dừng/khởi động lại các tiến trình này. **CHƯA XÁC MINH** tunnel gây lỗi lúc 22:48 trỏ tới cổng nào hoặc hostname Render có phải tunnel hiện tại. Cùng hostname trong ảnh chỉ hợp lệ khi có reverse proxy thực sự; thêm `/zalo/location` không tự chuyển từ cổng 8788 sang 8787.

Phát hiện thêm trong code: Profile Relay cũng mặc định 8787, xung đột Location Relay nếu không override. Đã đổi mặc định Profile sang 8788 và thêm regression test; biến `ZALO_PROFILE_RELAY_PORT` vẫn có thể override. Tiến trình Profile hiện tại thực tế đã dùng 8788; lỗi mặc định này không đủ để kết luận nguyên nhân sự cố lúc 22:48.

Nếu giữ hai relay riêng, chạy lại relay từ code hiện tại với secret/token tương ứng trong môi trường riêng, rồi hai tunnel riêng:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

```powershell
cloudflared tunnel --url http://127.0.0.1:8788
```

| Cấu hình Render | Giá trị cần dùng |
| --- | --- |
| ZALO_LOCATION_RELAY_URL | https://HOST-TUNNEL-8787/zalo/location |
| ZALO_PROFILE_RELAY_URL | https://HOST-TUNNEL-8788/zalo/profile |
| ZALO_LOCATION_RELAY_TOKEN | Khớp token Location Relay, ít nhất 32 ký tự |
| ZALO_PROFILE_RELAY_SECRET | Khớp secret Profile Relay hiện có |

Xác minh lại tên biến Profile Relay trong cấu hình khởi chạy hiện tại; không đưa secret vào URL, ảnh hoặc log. URL trycloudflare có thể đổi khi khởi động lại tunnel.

GET `/health` qua tunnel Location phải trả `service: ecollect-zalo-location-relay, version: 2`; Profile phải trả `service: ecollect-zalo-profile-relay, version: 2`. Relay cũ chỉ trả ok sẽ bị báo sai service/version, cần chạy code relay mới. Không tự tạo gateway hoặc đổi dịch vụ Render trong lần sửa này.

## GPS trước, Admin gán phường sau

MerchantApprovalView không còn WARD_ID cố định. Form giữ tên/điện thoại/địa chỉ/loại hình khi GPS lỗi; có nút lấy GPS riêng, tọa độ/bản đồ, và checkbox xác nhận vị trí quán. Đổi địa chỉ bỏ xác nhận. Submit dùng điểm đã xác nhận, tối đa 30 phút, không đổi token lại. Gửi lại hồ sơ không ghi đè phường đã có.

Admin Duyệt quán có danh mục phường, tạo phường qua API hiện có và tự chọn kết quả mới. Mã được ghi rõ là mã nội bộ, không tự coi là mã hành chính. Kiểm tra tọa độ/phường trước khi duyệt; gán phường, tọa độ và approval cùng transaction. Các API duyệt/tạo phường giữ quyền ADMIN. Sửa tên/điện thoại đã có vẫn được giữ.

### Migration cần áp dụng sau khi kiểm thử database riêng

`prisma/migrations/20260904100000_pending_merchant_optional_ward/migration.sql`:

- Cho phép merchant.ward_id NULL để giữ hồ sơ PENDING chưa có địa bàn.
- CHECK không cho merchant APPROVED thiếu ward_id.
- Giữ nguyên foreign key, dữ liệu lịch sử và mọi hồ sơ hiện có.
- Chưa chạy migration trên bất kỳ database nào. Cần backup và thử trên database test riêng trước khi người dùng cho phép triển khai. Không chỉ deploy frontend mới khi backend/schema cũ còn bắt ward_id.

## Kiểm tra

Chạy trực tiếp dependency đã có, không pnpm install. Windows sandbox chặn esbuild/userInfo ở một số lệnh; đã chạy lại lệnh test/build tương ứng ngoài sandbox. API build dùng output trong thư mục Temp riêng, không xóa output OneDrive đang dùng.

Database test cấu hình `localhost:5433/uco_test`; kiểm tra TCP cả trong/ngoài sandbox đều timeout. **CHƯA XÁC MINH** migration, SQL PostGIS và E2E với database thật; không thay bằng database production.

Integration UI Mini App dùng React/jsdom, fake-indexeddb và API mock có chặn fetch thật. Node `--test-force-exit` kết thúc runner sau khi tất cả assertions đã hoàn tất để không giữ background handle của Vite/jsdom. Nó không được dùng trong ứng dụng production.

### Kết quả lượt xác minh cuối

Các lệnh dưới chạy tại thư mục ứng dụng tương ứng. Đạt nghĩa là có exit code 0, không suy ra từ log build đang dở.

| Phần | Lệnh | Kết quả |
| --- | --- | --- |
| API typecheck | `npm.cmd run typecheck -- --incremental false` | ĐẠT. Lệnh mặc định trước đó lỗi EPERM khi ghi dist/tsconfig.tsbuildinfo; tắt incremental để không đụng output bị khóa. |
| API lint | `npm.cmd run lint` | ĐẠT |
| API tests không DB | `npm.cmd test -- --testPathIgnorePatterns=e2e-spec` | ĐẠT: 23 suites, 204 tests, gồm auth/collector/routes/relay/onboarding/media-contract và seed helper mock; không thực thi seed. |
| API build | `node ../../node_modules/@nestjs/cli/bin/nest.js build --path tsconfig.verify.json` | ĐẠT; main.js đã có trong Temp/ecollect-api-verify-0fc31d8c8ab94493897eb2b9a8a3a5e0. Config tạm extends tsconfig.build.json, incremental false; đã bỏ khỏi workspace sau build. |
| Admin typecheck | `npm.cmd run typecheck` | ĐẠT |
| Admin lint | `npm.cmd run lint` | ĐẠT |
| Admin tests | `npm.cmd test` | ĐẠT: 4 files, 50 tests; có sửa quán và thêm/gán phường rồi duyệt. |
| Admin production build | `npm.cmd run build` | ĐẠT: Next.js 14.2.35, 15/15 trang. |
| Mini typecheck | `npm.cmd run typecheck` | ĐẠT |
| Mini lint | `npm.cmd run lint` | ĐẠT |
| Mini tests | `npm.cmd test` | ĐẠT: 132 tests + 1 integration UI gồm PREVIEW/ACTIVE, QR/form/back/unmount/logout/login và API timeout; auth/outbox/media/collector/GPS/phone đều nằm trong lượt chạy. |
| Mini production build | `node ../../node_modules/typescript/bin/tsc -b` rồi `node node_modules/vite/bin/vite.js build --mode production` | ĐẠT. Lượt gọi Vite đầu dùng nhầm đường dẫn root node_modules không có Vite và thất bại; đã chạy lại đúng dependency có sẵn. 386 modules; cảnh báo chunk chính 614.21 kB và static/dynamic import trùng, không lỗi build. |
| ZMP packaging | `npx.cmd --yes --offline zmp-cli@4.0.3 sync-config dist/index.html` rồi `Copy-Item -LiteralPath app-config.json -Destination dist/app-config.json` | ĐẠT, CLI 4.0.3 từ cache offline, không deploy. |
| Git whitespace | `git -c core.safecrlf=false diff --check` | ĐẠT |
| Rà phạm vi và secret | Danh sách tracked diff + untracked, rà nội dung và mẫu private key/JWT/GitHub/AWS/live secret | 38 file thuộc code/test/schema/migration/tài liệu; không phát hiện secret hoặc artifact/file tạm trong thay đổi. Lockfile không đổi. dist/.next/tsbuildinfo được ignore. Quét mẫu không phải bảo đảm tuyệt đối về mọi loại secret. |

Sau kiểm tra không còn tiến trình test/build của lượt này. Giữ nguyên Profile Relay và tunnel hiện có. HEAD vẫn `fa8426c`; không commit, push, deploy hoặc ghi dữ liệu thật.

### Danh sách file thay đổi

- `apps/miniapp/src/pages/CollectorFlow.tsx`, `src/stores/auth-store.ts`, `src/lib/{api,offline-cache,outbox-db,zalo-client,merchant-location}.ts`, `src/components/MerchantApprovalView.tsx` (các đường dẫn rút gọn trong nhóm đều thuộc apps/miniapp).
- `apps/miniapp/test/{auth-store,collector-flow,outbox-persistence,zalo-client,merchant-location}.test.ts`, `apps/miniapp/test/collector-lifecycle.test.tsx`, `apps/miniapp/package.json`.
- `apps/admin/src/components/{approvals-view,approval-ward-form,merchants-view}.tsx`, `apps/admin/src/components/approvals-view.test.tsx`, `apps/admin/src/lib/api.ts`.
- `apps/api/src/demo/{zalo-location-relay,zalo-profile-relay,zalo-profile-relay.spec}.ts`, `apps/api/src/modules/auth/providers/{zalo-location.provider,zalo-location.provider.spec}.ts`.
- `apps/api/src/modules/{admin/admin.service,collections/collections.service,containers/containers.service,merchants/merchants.service,merchants/merchant-onboarding.spec,orders/orders.service,orders/orders.service.spec}.ts`, `apps/api/src/prisma/prisma.service.ts`.
- `packages/shared-types/src/index.ts`, `packages/validation/src/index.ts`, `prisma/schema.prisma`, migration kể trên và tài liệu này.

## Checklist iPhone và Android — CHƯA XÁC MINH THIẾT BỊ THẬT

1. Ghi phiên bản Zalo, runtime và user_id/collector_id/route_id/order_id (không token). Thử đúng đơn 20 lít ở PREVIEW và ACTIVE.
2. Bấm Thu gom → QR → form → quay lại/đóng app trước xác nhận. Mở lại, logout/login cùng Zalo: không có transaction mới, đơn vẫn READY hoặc ASSIGNED đúng route.
3. Xác nhận offline → mở lại: còn Chờ đồng bộ, payload/client_uuid không đổi. Tạo lỗi đồng bộ/timeout rồi retry: chỉ một transaction server. Collector khác không thấy/thu đơn đó.
4. API route lỗi/timeout: thông báo lỗi hoặc tuyến cache có nhãn, không 0/0 hoàn thành giả. Có ASSIGNED thiếu ACTIVE phải hiển thị mã lỗi và giữ dữ liệu.
5. Admin sửa điện thoại của điểm PENDING → Collector tải lại thấy số mới. Bấm gọi trên iOS/Android; nếu không mở, thử liên kết tel bằng lần bấm mới rồi sao chép. Không kết luận lỗi app chỉ vì số demo không liên lạc được.
6. Thử quyền vị trí bị từ chối, SDK thiếu token, timeout, URL GPS trỏ Profile Relay, token relay sai. Đối chiếu giai đoạn/mã lỗi; không gửi lại location token đã dùng.
7. Đăng ký quán không có phường trong danh mục: lấy GPS, xem bản đồ, xác nhận, gửi PENDING. GPS lỗi giữ form; submit thành công không gọi GPS lần hai.
8. Admin thêm phường nội bộ, gán và duyệt. Thử mã trùng, phường không hoạt động, tọa độ thiếu/sai; thử quyền Merchant/Collector. Quán chưa duyệt/chưa có phường không READY/tham gia tuyến.
