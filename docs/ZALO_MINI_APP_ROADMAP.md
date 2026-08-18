# Lộ trình tích hợp Eco-Oil với Zalo Mini App

Ngày khảo sát: 19/08/2026
Phạm vi: đánh giá hiện trạng và lập kế hoạch; chưa triển khai OAuth, chưa đổi API, package, database hay source code.

## Kết luận nhanh

Eco-Oil đã có giao diện mobile, luồng quán/người thu gom, offline outbox và dependency `zmp-sdk`, nhưng **chưa sẵn sàng để đóng gói hoặc gửi duyệt Zalo Mini App**. Các phần chặn chính là:

1. Chưa có cấu hình dự án Zalo (`app-config.json`) và chưa liên kết project với một Mini App ID bằng Zalo Mini App CLI/Extension.
2. Luồng đăng nhập thật hiện dùng access token như `zalo_id`; đây không phải định danh bền vững và backend real provider vẫn là TODO.
3. Luồng lấy số điện thoại và vị trí chưa trao đổi token một lần ở backend bằng App Secret theo tài liệu Zalo.
4. Adapter storage thật dựa vào một global tự giả định, trong khi Zalo yêu cầu Native Storage và không hỗ trợ `localStorage`, `sessionStorage`, cookie như web thường.
5. Chưa xin quyền Zalo cho vị trí, số điện thoại, camera, QR và Native Storage; chưa cấu hình domain/CORS cho runtime Zalo.
6. Chưa kiểm thử SDK, outbox và lưu token trên thiết bị thật trong ứng dụng Zalo.

Phần nghiệp vụ hiện có có thể tái sử dụng. Nên tích hợp theo các thay đổi nhỏ bên dưới, luôn giữ `mock` làm đường quay lại cho local và CI.

## Hiện trạng

| Thành phần | Hiện trạng trong repo | Mức sẵn sàng |
|---|---|---|
| React/Vite Mini App | React 19, Vite 7, TypeScript; UI mobile đã chạy trên trình duyệt | Tốt cho web, chưa đóng gói Zalo |
| Zalo SDK | `zmp-sdk ^2.53.0` đã cài; có adapter real/mock | Một phần |
| Zalo manifest | Không có `apps/miniapp/app-config.json` hoặc cấu hình liên kết Mini App ID | Thiếu |
| Công cụ đóng gói | Không có script ZMP CLI; dự án hiện chỉ build bằng Vite | Thiếu |
| Entry point | `index.html` và `src/main.tsx` dùng `id="root"`; tài liệu chuyển đổi web app của Zalo yêu cầu root do Zalo tạo có `id="app"` | Chưa tương thích |
| Asset/public path | Vite chưa cấu hình cho đường dẫn CDN `/zapps/[MINI_APP_ID]`; assets chưa được khai báo trong `app-config.json` | Chưa tương thích |
| Login Mini App | `LoginScreen` gọi `getAccessToken()`, sau đó frontend gửi token vào field `zalo_id` và phone giả `zmp-user` | Không dùng được cho production |
| Backend Zalo auth | `RealZaloAuthProvider.verify()` chỉ ném `ServiceUnavailableException`; TODO gọi Zalo Graph API | Chưa làm |
| User profile | Chưa gọi `getUserInfo`; chưa dùng ID ổn định theo Zalo App, tên hoặc avatar thật | Thiếu |
| Phone | Chưa gọi `getPhoneNumber`; form đăng ký vẫn cho nhập phone và `zalo_id` thủ công | Thiếu |
| Location | Real adapter gọi `getLocation()` nhưng bỏ token trả về rồi dùng browser geolocation | Sai luồng Zalo production |
| QR | Real adapter đã gọi `scanQRCode()` và kiểm tra chuỗi; có nhập mã can thủ công dự phòng | Gần sẵn sàng, cần quyền và test thiết bị |
| Camera/album | Real adapter gọi `chooseImage()` chỉ với `camera`; UI có file picker web dự phòng | Một phần |
| Storage | Real adapter tìm `window.ZaloMiniAppSDK.nativeStorage`; mock dùng `localStorage` | Real adapter chưa theo API chính thức |
| Offline outbox | Dexie/IndexedDB, retry idempotent đã có | Cần test persistence trên Zalo WebView; tài liệu công khai không cam kết thay cho test thiết bị |
| API URL | `VITE_API_BASE_URL` đã hỗ trợ URL tuyệt đối hoặc `/api/v1` qua proxy local | Sẵn sàng về cấu hình |
| CORS | Backend đọc danh sách `CORS_ORIGINS`; hiện chưa có origin Zalo | Thiếu `https://h5.zdn.vn` ở production |
| Tài liệu deploy | `DEPLOY.md` ghi rõ đây mới là bản demo trình duyệt | Chưa có quy trình ZMP |

### Những phần đang mock hoặc TODO

- `apps/miniapp/src/lib/zalo-client.ts`
  - `MockZaloClient` dùng tài khoản seed, token dạng `mock-access-token:*`, browser GPS, QR rỗng và `localStorage`.
  - `RealZaloClient.login()` trả access token như `zaloId` và phone giả `zmp-user`.
  - `RealZaloClient.getLocation()` bỏ location token; TODO trao đổi token ở backend.
  - `RealZaloClient.chooseImage()` chỉ mở camera.
  - Phát hiện runtime bằng các global phỏng đoán; cần xác minh với project do ZMP CLI khởi tạo.
- `apps/miniapp/src/components/LoginScreen.tsx`
  - Khi real SDK lỗi, màn hình tự chuyển sang tài khoản thử nghiệm. Production không nên âm thầm mở dev login vì lỗi xác thực thật.
  - Đăng ký quán vẫn có field “Mã Zalo (bản thử nghiệm)”.
- `apps/miniapp/src/stores/auth-store.ts`
  - Có hai đường `loginSeed` và `loginWithZalo`, nhưng đường real mới chỉ chuyển access token sang API hiện tại.
- `apps/api/src/modules/auth/providers/real-zalo-auth.provider.ts`
  - Toàn bộ provider là TODO và chưa xác minh token.
- `apps/api/src/modules/auth/auth.service.ts`
  - Internal access/refresh JWT và rotation đã hoàn chỉnh.
  - Auth real vẫn phụ thuộc provider TODO; mặc định role mới là MERCHANT.
- `README.md` và `DEPLOY.md`
  - Đều mô tả mock/browser demo; chưa có App ID, quyền, ZMP deploy hoặc kiểm duyệt.

## Thành phần còn thiếu và luồng đúng

### 1. Manifest và đóng gói

Zalo yêu cầu `app-config.json` ở root của project Mini App. Với repo này, root đó là `apps/miniapp`. Cần chạy `zmp init` tại đây, chọn **Using ZMP to deploy only**, liên kết đúng Mini App ID, rồi review file sinh ra trước khi commit.

Manifest tối thiểu cần cấu hình tên Eco-Oil, màu header, title, nút back/status bar và danh sách CSS/JS output. Project hiện dùng root DOM `root`, trong khi index do Zalo tạo dùng `app`; cần đồng bộ entry point. Vite base/public path và các chunk động cũng phải chạy dưới CDN path của Zalo.

Không commit file `.env` hoặc token đăng nhập do CLI sinh ra. Mini App ID và Zalo App ID là định danh, không phải secret, nhưng vẫn phải phân biệt hai giá trị này.

### 2. Access token và định danh người dùng

Luồng mục tiêu:

1. Mini App gọi `getAccessToken()` trong runtime Zalo.
2. Có thể gọi `getUserInfo()` để lấy `userInfo.id`; ID này ổn định trong phạm vi **Zalo App cha**. Tên/avatar cần `scope.userInfo` và phải xin đúng ngữ cảnh.
3. Gửi access token tới backend qua HTTPS.
4. Backend xác minh token theo cơ chế server-to-server chính thức áp dụng cho Zalo App/Mini App đã đăng ký, lấy định danh ổn định, rồi phát hành JWT Eco-Oil hiện có.
5. Không lưu access token làm `users.zalo_id`, không nhận một `userInfo.id` tuỳ ý từ client làm bằng chứng xác thực, và không tự giải mã/đoán cấu trúc token.

Tài liệu chuyển đổi web app chính thức cho phép dùng trực tiếp access token để định danh request hoặc đổi sang JWT riêng và khuyến nghị JWT riêng. Eco-Oil đã có JWT access/refresh nên nên giữ mô hình thứ hai.

**Điểm chặn cần Zalo xác nhận:** trang `getAccessToken` công khai được rà trong khảo sát này không mô tả endpoint introspection tổng quát để backend đổi access token thành user ID. Trước khi viết `RealZaloAuthProvider`, chủ App phải lấy hướng dẫn server-side hiện hành trong Mini App Center/tài khoản Developer hoặc xác nhận với Zalo Support cho đúng Zalo App ID. Không được thay bằng suy đoán endpoint Graph API.

### 3. Thông tin người dùng và số điện thoại

- `getUserInfo()` trả ID theo Zalo App. ID có sẵn; tên/avatar cần user consent (`scope.userInfo`).
- `getPhoneNumber()` cần quyền từ Zalo và người dùng. SDK trả một `token` dùng **một lần**, hết hạn sau **2 phút**.
- Client gửi phone token và user access token tới backend ngay lập tức.
- Backend gọi `GET https://graph.zalo.me/v2.0/me/info` với các header:
  - `access_token: <user access token>`
  - `code: <phone token>`
  - `secret_key: <Zalo App Secret Key>`
- Backend lấy `data.number`; client không được tự khai số điện thoại như bằng chứng từ Zalo.
- Chỉ xin phone khi đăng ký quán hoặc khi nghiệp vụ thực sự cần; phải giải thích mục đích ngay trước hộp thoại quyền.

### 4. Vị trí

Trong Zalo thật, `getLocation()` trả token một lần, hết hạn sau 2 phút. Backend trao đổi token bằng cùng endpoint `/v2.0/me/info` và các header access token/code/secret key. Không bỏ token rồi dùng `navigator.geolocation` như real adapter hiện tại.

Mock browser vẫn có thể dùng `navigator.geolocation` để local/CI không phụ thuộc Zalo. Khi người dùng từ chối, UI tiếp tục dùng tâm phường như hiện nay và phải ghi rõ đó là vị trí ước lượng.

### 5. Quyền cần khai báo

| Nhu cầu Eco-Oil | API | Quyền theo tài liệu chính thức | Cách xin |
|---|---|---|---|
| ID cơ bản | `getAccessToken`, `getUserInfo` | Access token/ID cơ bản có sẵn; tên/avatar cần `scope.userInfo` | Xin user đúng ngữ cảnh nếu cần tên/avatar |
| Số điện thoại | `getPhoneNumber` | Zalo & User | Đăng ký trong Mini App Center, sau đó xin `scope.userPhonenumber` |
| Vị trí tuyến/thu gom | `getLocation` | Zalo & User | Đăng ký trong Mini App Center, sau đó xin `scope.userLocation` |
| Chụp ảnh dầu/biên nhận | `chooseImage` với `camera` | Zalo Camera | Xin quyền trong Mini App Center; xử lý người dùng từ chối quyền hệ điều hành |
| Quét QR can | `scanQRCode` | Zalo “Mở Scan QR Code trên Zalo” | Xin quyền trong Mini App Center |
| Chọn ảnh có sẵn | `chooseImage` với `album` | Tài liệu `chooseImage` hỗ trợ `album`; bảng quyền công khai không nêu một quyền “đọc thư viện” riêng | Giữ file picker/album fallback và xác minh trên Android/iOS; không xin quyền “Lưu ảnh vào điện thoại” vì Eco-Oil không lưu ảnh xuống máy |
| Lưu JWT/config | Native Storage APIs | Zalo “Sử dụng native storage” | Xin quyền trong Mini App Center |

Không xin tất cả quyền lúc khởi động. Dùng `getSetting`, `authorize` và khi cần `openPermissionSetting`; xin đúng lúc người dùng bắt đầu đăng ký, mở tuyến, quét QR hoặc chụp ảnh. Mã `-201` là người dùng từ chối và phải có đường dự phòng phù hợp.

### 6. Domain API và CORS

- API production phải là một hostname HTTPS hợp lệ, không dùng IP hoặc HTTP.
- Domain cần khai báo/whitelist cho Mini App là **origin thực tế của Render API**, ví dụ `https://<eco-oil-api>.onrender.com`; không gồm `/api/v1`. Repo chỉ có domain mẫu nên chưa thể ghi giá trị chính xác. Chủ dự án cần cung cấp URL Render đang chạy và khai báo nó trong phần API Domain/cấu hình mạng của Mini App Center nếu giao diện App hiện hành yêu cầu.
- `VITE_API_BASE_URL` trong bản ZMP phải là URL đầy đủ, ví dụ `https://<eco-oil-api>.onrender.com/api/v1`; proxy `/api` chỉ dành cho local Vite.
- Backend phải thêm `https://h5.zdn.vn` vào biến `CORS_ORIGINS`. Middleware phải trả đúng **một** origin khớp request, kể cả preflight `OPTIONS`; không trả danh sách origin phân cách bằng dấu phẩy trong một header.
- Giữ các origin Vercel/Admin hiện có nếu vẫn vận hành browser demo song song.

### 7. Secret và biến cấu hình

Chỉ backend/secret manager được giữ:

- `ZALO_APP_SECRET`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `DATABASE_URL`, `REDIS_URL`
- `ZALO_REFRESH_TOKEN` nếu sau này dùng CI/CD/Open API của Zalo
- Mọi deployment token như `ZMP_TOKEN`/developer token nếu công cụ tạo ra

Có thể xuất hiện ở client/build config vì không phải secret:

- `MINI_APP_ID`
- `ZALO_APP_ID` (vẫn không cần đưa vào frontend nếu SDK/project config đã quản lý)
- `VITE_API_BASE_URL`

Không đặt App Secret/access token/refresh token trong biến `VITE_*`, `NEXT_PUBLIC_*`, `app-config.json`, source code, log CI hoặc repo. `.env.example` chỉ ghi placeholder.

## Thứ tự triển khai từng bước nhỏ

Mỗi bước dưới đây giới hạn tối đa năm file. Sau mỗi bước tạo commit riêng và có thể quay lại mock mà không ảnh hưởng nghiệp vụ đang chạy.

### Bước 0 — Chuẩn bị trên Zalo Developer (không sửa file)

**Thao tác**

- Tạo/xác nhận Zalo App cha và Eco-Oil Mini App; ghi riêng `ZALO_APP_ID` và `MINI_APP_ID`.
- Cấp vai trò Admin/Developer cho tài khoản dùng deploy.
- Lấy URL API production HTTPS.
- Mở ticket/xác nhận hướng dẫn server-side xác minh Mini App access token cho App này.

**Hoàn thành khi:** có đủ ID, quyền quản trị, API origin và hướng dẫn xác minh token chính thức.
**Test:** đăng nhập được Mini App Center và Extension bằng tài khoản Developer.
**Quay lại mock:** không đổi gì trong repo; browser demo tiếp tục chạy.

### Bước 1 — Khởi tạo project ZMP và đóng gói Vite

**Tối đa 5 file:**

1. `apps/miniapp/app-config.json` (mới, do `zmp init` tạo rồi review)
2. `apps/miniapp/package.json`
3. `apps/miniapp/vite.config.ts`
4. `apps/miniapp/index.html`
5. `apps/miniapp/src/main.tsx`

**Thay đổi:** liên kết Mini App ID; dùng root `app`; cấu hình base/assets và script build/deploy theo ZMP CLI/Extension hiện hành. Không commit `.env` của ZMP.
**Hoàn thành khi:** `pnpm build` vẫn pass; ZMP build/deploy Development pass; QR Development mở được Eco-Oil trên Zalo và tải đủ JS/CSS/logo. Tổng version dưới 10 MB, mỗi file dưới 3 MB.
**Test:** browser local, ZMP Development trên Android và iOS, refresh/deep link, chunk động.
**Quay lại mock:** giữ script Vite local; dùng commit trước hoặc build browser với mock, không xoá adapter mock.

### Bước 2 — Chuẩn hoá runtime và Native Storage

**Tối đa 5 file:**

1. `apps/miniapp/src/lib/zalo-client.ts`
2. `apps/miniapp/src/lib/storage.ts`
3. `apps/miniapp/src/lib/api.ts`
4. `apps/miniapp/src/stores/auth-store.ts`
5. `apps/miniapp/test/zalo-client.test.ts`

**Thay đổi:** dùng API Native Storage chính thức thay cho global giả định; điều chỉnh async boundary nếu SDK yêu cầu; mock vẫn dùng browser/memory storage. Production real không được âm thầm rơi sang dev accounts khi SDK lỗi.
**Hoàn thành khi:** JWT Eco-Oil còn sau đóng/mở Mini App; logout xoá token nhưng không xoá outbox; refresh single-flight vẫn pass.
**Test:** unit real/mock factory và storage; đóng/kill Zalo rồi mở lại trên thiết bị. Kiểm tra riêng Dexie outbox qua reload/kill vì tài liệu công khai không thay thế được test WebView.
**Quay lại mock:** cấu hình rõ `ZALO_AUTH_MODE=mock` ở backend và mock runtime cho local/test; không phụ thuộc lỗi SDK để kích hoạt mock.

### Bước 3 — Chuẩn hoá contract xác thực Zalo

**Tối đa 5 file:**

1. `packages/validation/src/index.ts`
2. `packages/shared-types/src/index.ts`
3. `apps/api/src/modules/auth/providers/zalo-auth.provider.ts`
4. `apps/miniapp/src/lib/api.ts`
5. `apps/api/test/auth.e2e-spec.ts`

**Thay đổi:** request real mang access token/phone token theo tên đúng; không dùng field `zalo_id` để nhét access token. Giữ request mock tương thích trong mock mode.
**Hoàn thành khi:** schema phân biệt real credentials với seed login, từ chối payload lẫn lộn; không log token.
**Test:** validation real/mock, token thiếu/hỏng, mock regression.
**Quay lại mock:** `ZALO_AUTH_MODE=mock` tiếp tục nhận seed identity; endpoint dev account chỉ bật mock như hiện nay.

### Bước 4 — Xác minh token ở backend và phát hành JWT Eco-Oil

Chỉ bắt đầu sau khi Bước 0 có hướng dẫn server-side chính thức.

**Tối đa 5 file:**

1. `apps/api/src/modules/auth/providers/real-zalo-auth.provider.ts`
2. `apps/api/src/modules/auth/auth.service.ts`
3. `apps/api/src/modules/auth/auth.module.ts`
4. `apps/api/test/auth.e2e-spec.ts`
5. `.env.example`

**Thay đổi:** provider gọi endpoint Zalo đã được xác nhận, lấy user ID ổn định; App Secret chỉ đọc từ backend env; giữ internal JWT/refresh rotation hiện có.
**Hoàn thành khi:** token hợp lệ tạo/đăng nhập đúng một user; token hết hạn/giả trả 401; client không thể giả `zalo_id`, role hoặc phone. API crash rõ nếu real mode thiếu secret bắt buộc.
**Test:** provider HTTP mock/contract test, auth e2e, refresh/logout regression; một test thiết bị thật.
**Quay lại mock:** đổi duy nhất `ZALO_AUTH_MODE=mock` và restart API; không thay database/schema.

### Bước 5 — Login, hồ sơ và số điện thoại thật

**Tối đa 5 file:**

1. `apps/miniapp/src/lib/zalo-client.ts`
2. `apps/miniapp/src/components/LoginScreen.tsx`
3. `apps/miniapp/src/stores/auth-store.ts`
4. `apps/miniapp/src/lib/api.ts`
5. `apps/miniapp/test/zalo-client.test.ts`

**Thay đổi:** `getAccessToken`, `getUserInfo`, `getPhoneNumber`; xin phone đúng lúc đăng ký; bỏ field Zalo ID thủ công khỏi real flow; xử lý từ chối quyền và token 2 phút.
**Hoàn thành khi:** merchant mới đăng ký bằng identity/phone Zalo thật; user cũ đăng nhập lại về đúng tài khoản; real error không mở danh sách seed.
**Test:** unit adapter, từ chối `scope.userInfo`/phone, phone token hết hạn, Android/iOS thực.
**Quay lại mock:** màn seed login chỉ hiện khi mock mode được chọn chủ động; giữ toàn bộ `MockZaloClient` test.

### Bước 6A — Backend trao đổi location token

**Tối đa 5 file:**

1. `apps/api/src/modules/auth/providers/zalo-location.provider.ts` (mới hoặc provider dùng chung)
2. `apps/api/src/modules/auth/auth.controller.ts`
3. `apps/api/src/modules/auth/auth.service.ts`
4. `packages/validation/src/index.ts`
5. `apps/api/test/auth.e2e-spec.ts`

**Thay đổi:** endpoint authenticated nhận access token + location token, trao đổi server-side bằng App Secret; không trả/log secret.
**Hoàn thành khi:** trả lat/lng hợp lệ; token dùng lại/hết hạn bị từ chối có mã rõ.
**Test:** Zalo HTTP mock, error mapping, auth/RBAC.
**Quay lại mock:** endpoint không được gọi trong mock; browser GPS/tâm phường vẫn hoạt động.

### Bước 6B — Dùng location token trong Mini App

**Tối đa 5 file:**

1. `apps/miniapp/src/lib/zalo-client.ts`
2. `apps/miniapp/src/lib/api.ts`
3. `apps/miniapp/src/pages/CollectorFlow.tsx`
4. `apps/miniapp/src/components/LoginScreen.tsx`
5. `apps/miniapp/test/zalo-client.test.ts`

**Thay đổi:** real client giữ và gửi token ngay; collector/registration dùng location backend trả về; từ chối quyền vẫn có fallback rõ.
**Hoàn thành khi:** route và collection trên thiết bị có vị trí Việt Nam hợp lý; không còn TODO bỏ location token.
**Test:** grant/deny/timeout, token hết hạn, tâm phường fallback, test thiết bị Android/iOS.
**Quay lại mock:** `MockZaloClient.getLocation()` tiếp tục browser GPS/fallback.

### Bước 7 — QR, camera và album trên Zalo thật

**Tối đa 5 file:**

1. `apps/miniapp/src/lib/zalo-client.ts`
2. `apps/miniapp/src/pages/CollectorFlow.tsx`
3. `apps/miniapp/src/components/GradePhotoPicker.tsx`
4. `apps/miniapp/src/pages/StationDeliveryFlow.tsx`
5. `apps/miniapp/test/grade-photo-picker.test.ts`

**Thay đổi:** xin quyền QR/camera đúng ngữ cảnh; `chooseImage` hỗ trợ camera và album, cùng pipeline nén 1280/JPEG 0.7; giữ nhập QR/file picker dự phòng.
**Hoàn thành khi:** quét đúng mã can, chọn/chụp ảnh, preview, outbox, sync batch thành công trên thiết bị; từ chối camera không làm kẹt giao dịch.
**Test:** QR rỗng/sai, camera denied, album, ảnh lớn, offline/reload/sync; Android/iOS thật.
**Quay lại mock:** manual QR và `<input type="file">` luôn hoạt động; không nới quy tắc ảnh bắt buộc.

### Bước 8 — Cấu hình production và tài liệu vận hành

**Tối đa 5 file:**

1. `.env.example`
2. `apps/miniapp/.env.example`
3. `README.md`
4. `DEPLOY.md`
5. `.github/workflows/ci.yml`

**Thay đổi:** ghi placeholder cho ID/domain, backend-only secret, build/deploy Development/Testing; thêm CORS `https://h5.zdn.vn` bằng env production; CI không in secret.
**Hoàn thành khi:** người mới có thể build browser mock và ZMP Development từ tài liệu; repo không theo dõi `.env`/token.
**Test:** secret scan, `git ls-files` env audit, typecheck/lint/test/build, preflight từ origin Zalo.
**Quay lại mock:** tài liệu giữ nguyên lệnh browser demo và `ZALO_AUTH_MODE=mock` cho local/CI.

### Bước 9 — Device acceptance và gửi duyệt (không cần sửa source nếu pass)

**Hoàn thành khi:** toàn bộ checklist thiết bị và gửi duyệt bên dưới pass; phiên bản Testing được Zalo chấp thuận.
**Test:** hai hệ điều hành, hai role, online/offline, quyền grant/deny, cold start.
**Quay lại:** publish lại phiên bản Testing đã duyệt trước đó; backend có thể tạm chuyển mock chỉ trong môi trường test riêng, không bật dev accounts trên production public.

## Thông tin cần chuẩn bị trên Zalo Developer

- Tài khoản Zalo đã xác minh và có vai trò Admin/Developer.
- Zalo App cha đã tạo; `ZALO_APP_ID` chính xác.
- Eco-Oil Mini App đã tạo; `MINI_APP_ID` chính xác và liên kết với App cha.
- Zalo App Secret đưa thẳng vào secret manager của API; không gửi qua chat, issue, ảnh chụp hoặc commit.
- Hướng dẫn/endpoint server-side xác minh access token được xác nhận cho App này.
- Production API origin HTTPS chính xác để whitelist và cấu hình `VITE_API_BASE_URL`/CORS.
- Yêu cầu quyền kèm lý do và ảnh màn hình cho: số điện thoại, vị trí, camera, QR scanner, Native Storage.
- Tên “Eco-Oil”, logo, ảnh bìa, mô tả đúng tính năng, danh mục dịch vụ phù hợp.
- Chính sách quyền riêng tư/điều khoản, hotline hỗ trợ và mô tả mục đích thu thập phone/location/photo.
- Tài khoản/quy trình test cho merchant và collector; dữ liệu test không chứa thông tin thật không cần thiết.
- Thiết bị Android/iOS có Zalo mới và tài khoản được phép thử Development/Testing.

## Checklist test trên thiết bị thật

- [ ] Mở QR Development/Testing trong ứng dụng Zalo; không dùng browser/simulator để kết luận SDK đã hoạt động.
- [ ] App tải đủ CSS/JS/logo ở CDN path, back/status bar/safe area đúng.
- [ ] `getAccessToken` đăng nhập đúng user; đóng/mở app vẫn hydrate internal JWT.
- [ ] Một user không tạo user mới sau mỗi lần access token thay đổi.
- [ ] User từ chối tên/avatar vẫn dùng được phần không cần dữ liệu đó.
- [ ] Xin số điện thoại đúng lúc đăng ký; đồng ý/từ chối/token quá 2 phút đều có UX rõ.
- [ ] Vị trí grant/deny/timeout; fallback được gắn nhãn ước lượng.
- [ ] QR đúng/sai/rỗng; nhập mã can thủ công luôn dùng được.
- [ ] Camera và album trên Android/iOS; ảnh được nén, preview, giữ trong outbox và sync thành công.
- [ ] Mất mạng khi tạo collection; kill app; mở lại; outbox còn nguyên và sync đúng một lần.
- [ ] Native Storage giữ access/refresh token qua restart; logout xoá token nhưng không xoá outbox chưa sync.
- [ ] CORS preflight từ `https://h5.zdn.vn` pass; API dùng HTTPS và không mixed content.
- [ ] Merchant chỉ thấy luồng merchant; collector chỉ thấy luồng collector; không thấy dev/admin accounts.
- [ ] Refresh token single-flight khi nhiều request cùng 401.
- [ ] Body ảnh gần 10 MB trả lỗi tiếng Việt đúng, không 500.
- [ ] Version dưới 10 MB và từng file dưới 3 MB.
- [ ] Kiểm tra cold start API trước demo; hiển thị retry thân thiện nếu Render đang thức dậy.

## Checklist gửi duyệt Zalo Mini App

- [ ] Version loại Testing đã deploy bằng ZMP CLI/VS Code Extension và có mô tả thay đổi.
- [ ] App liên kết đúng `MINI_APP_ID`; không nhầm với `ZALO_APP_ID`.
- [ ] Tên, logo, ảnh bìa, mô tả và danh mục dịch vụ nhất quán với Eco-Oil.
- [ ] API domain production HTTPS đã khai báo theo cấu hình Mini App Center hiện hành.
- [ ] Các quyền phone/location/camera/QR/Native Storage đã gửi duyệt, có lý do và ảnh ngữ cảnh.
- [ ] Không xin quyền hàng loạt khi mở app; nội dung xin quyền giải thích mục đích rõ ràng.
- [ ] Chính sách quyền riêng tư và thông tin hỗ trợ có thể truy cập.
- [ ] Không có App Secret, access token, refresh token, seed/admin account hoặc dev UI trong bundle/log.
- [ ] Luồng auth dùng chuẩn Zalo và backend xác minh identity; không tin `zalo_id` do client tự gửi.
- [ ] Merchant/collector flow hoàn chỉnh, không crash, loading/performance chấp nhận được.
- [ ] Link ngoài (Google Maps nếu giữ) được kiểm tra với chính sách review và chỉ mở theo thao tác người dùng.
- [ ] Đã test trên Android/iOS bằng bản Testing gần nhất, không chỉ simulator.
- [ ] Có hướng rollback về phiên bản Testing đã duyệt trước nếu bản mới lỗi.
- [ ] Sau khi trạng thái “Đã duyệt”, người có quyền mới chọn Publish.

## Tài liệu Zalo chính thức đã tham khảo

Các trang dưới đây thuộc Zalo Platform Document Hub và được kiểm tra ngày 19/08/2026:

- [Bắt đầu với Zalo Mini App](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/overview)
- [Tài khoản Nhà phát triển](https://docs.zaloplatforms.com/docs/MA/intro/intro/mini-app-account)
- [Tạo project bằng Command Line](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/dev-use-command-line)
- [Cấu hình app-config.json](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/app-config)
- [Chuyển đổi Web App thành Zalo Mini App](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/convert-web-app-to-mini-app)
- [Zalo Mini App Extension](https://docs.zaloplatforms.com/docs/MA/devtools/ext/install)
- [Khởi động và Device Mode](https://docs.zaloplatforms.com/docs/MA/devtools/ide/start)
- [Deploy bằng Extension](https://docs.zaloplatforms.com/docs/MA/devtools/ext/deploy)
- [Phát hành Zalo Mini App](https://docs.zaloplatforms.com/docs/MA/intro/public-mini-program)
- [Hướng dẫn xin cấp quyền](https://docs.zaloplatforms.com/docs/MA/intro/request-permission)
- [`authorize`](https://docs.zaloplatforms.com/docs/MA/api/user/authorization/authorize)
- [`getAccessToken`](https://docs.zaloplatforms.com/docs/MA/api/user/user-information/getAccessToken)
- [`getUserInfo`](https://docs.zaloplatforms.com/docs/MA/api/user/user-information/getUserInfo)
- [`getPhoneNumber`](https://docs.zaloplatforms.com/docs/MA/api/user/user-information/getPhoneNumber)
- [`getLocation`](https://docs.zaloplatforms.com/docs/MA/api/location/getLocation)
- [`scanQRCode`](https://docs.zaloplatforms.com/docs/MA/api/device/qr/scanQRCode)
- [`chooseImage`](https://docs.zaloplatforms.com/docs/MA/api/media/file/chooseImage)
- [Các lỗi kỹ thuật thường gặp](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/frequently-solved-issues)
- [Native Storage: removeStorage](https://docs.zaloplatforms.com/docs/MA/api/data-caching/removeStorage)
- [Native Storage: clearStorage](https://docs.zaloplatforms.com/docs/MA/api/data-caching/clearStorage)

> Lưu ý về độ chính xác: tài liệu công khai đã xác nhận access token, user info, phone/location token exchange, quyền, CORS và đóng gói. Riêng endpoint server-side tổng quát để xác minh access token thành user ID không được mô tả rõ trên trang `getAccessToken` đã rà; đây là điều kiện phải xác nhận bằng tài khoản App/Mini App thực hoặc Zalo Support trước khi triển khai, không được tự suy đoán.
