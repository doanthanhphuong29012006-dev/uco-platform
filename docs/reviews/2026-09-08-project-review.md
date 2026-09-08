# Review ECOllect — 08/09/2026

## Kết luận và giới hạn

Review mã nguồn tại commit `149fadc`. Worktree sạch trước khi review. Phạm vi rà soát: API, Prisma/migrations, Admin, Mini App, shared types/validation/API client, auth, orders/routes, collections/outbox/station delivery, quản lý quán/can, GPS/phone và tài liệu triển khai.

Có 11 nhóm vấn đề cần xử lý, xếp theo mức ảnh hưởng. Đây là kết luận từ đường đi trong code; các tình huống cạnh tranh và thiết bị khác chưa được tái hiện trên database/điện thoại thật trong lượt review này. Không khẳng định chúng chính là nguyên nhân của mọi lần lỗi trong ảnh cũ.

Không sửa mã ứng dụng, không kết nối hoặc ghi production, không migration/seed/reset, không cài dependency, không commit/push/deploy. Chỉ tạo báo cáo và prompt sửa.

## Các phát hiện

### R01 — P1: E2E có thể xóa nhầm dữ liệu khi cấu hình database test thiếu hoặc sai

- [setup-env.ts](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/test/setup-env.ts:7>) chỉ nạp `.env.test` nếu file tồn tại; nếu không, vẫn tiếp tục với biến môi trường đang có. `.env.test` không được Git track.
- [full-flow.e2e-spec.ts](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/test/full-flow.e2e-spec.ts:40>) gọi `deleteMany()` không có bộ lọc trên alerts, payments, routes, deliveries, transactions, audit logs và orders; sau đó reset dung tích tất cả station.
- [PrismaService](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/prisma/prisma.service.ts:51>) kết nối trực tiếp, không xác minh DB dùng một lần. Jest mặc định chạy cả spec và e2e-spec.
- Nếu chạy test trong PowerShell còn `DATABASE_URL` production như quy trình migration trước đó, và thiếu cấu hình test ghi đè đúng, suite có thể kết nối rồi xóa dữ liệu thật. Ngay cả DB test dùng chung cũng bị xóa dữ liệu của các suite khác.
- Sửa: E2E phải dừng trước kết nối nếu chưa xác nhận đích DB test riêng, từ chối URL production/inherited không được phép; dùng DB/schema cô lập và cleanup theo fixture. Không chỉ dựa vào `NODE_ENV=test` hoặc tên DB chứa chữ test.
- Test: thiếu/sai cấu hình, URL Neon production, DB local không thuộc môi trường test đều bị chặn trước truy vấn; fixture khác không bị xóa.
- Không chạy E2E trong lượt review này.

### R02 — P1: Hai UUID khác nhau có thể ghi hai giao dịch thu gom cho cùng một đơn

- [CollectionsService.processOne](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/collections/collections.service.ts:97>) đọc trạng thái đơn trước khi ghi, không khóa đơn hoặc dùng conditional state transition.
- [INSERT chỉ chống trùng client_uuid](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/collections/collections.service.ts:272>) và [kiểm tra trạng thái cũ](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/collections/collections.service.ts:303>) không ngăn hai request cùng đọc ASSIGNED/READY.
- [Prisma CollectionTransaction](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/prisma/schema.prisma:370>) chỉ unique clientUuid; orderId không unique. Không tìm thấy ràng buộc tương đương trong migrations.
- Khi gửi đồng thời hai UUID khác nhau cho một đơn, cả hai có thể insert và update COLLECTED; số lít và dữ liệu đối soát có thể bị tính hai lần.
- Sửa bằng khóa/điều kiện nguyên tử và ràng buộc DB phù hợp, giữ idempotency cho replay cùng UUID. Phải phối hợp lock order với start/cancel route, không tạo deadlock.
- Test DB riêng: đồng thời cùng đơn/hai UUID chỉ có một giao dịch; replay cùng UUID trả giao dịch cũ; không nhân đôi lít hoặc thay đổi can lần hai.

### R03 — P1: Tạo/hủy đơn và hủy ca còn race condition

- [createReady](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/orders/orders.service.ts:94>) kiểm tra đơn mở ngoài transaction tạo mới; hai request có thể cùng vượt kiểm tra rồi tạo hai đơn mở cho một can.
- [cancel](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/orders/orders.service.ts:176>) đọc READY rồi update chỉ theo id ở dòng 188. Nếu startRoute/thu gom chạy giữa hai bước, cancel có thể ghi đè ASSIGNED/COLLECTED thành CANCELLED.
- [cancelRoute](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/orders/orders.service.ts:346>) kiểm tra các stop COLLECTED trước transaction; có thể hủy ca dựa trên dữ liệu cũ trong khi collector vừa thu một điểm.
- Hậu quả: route/order/transaction mâu thuẫn, điểm không thao tác được hoặc mất khỏi danh sách phù hợp.
- Test: tạo READY song song; cancel đơn đua với startRoute/collect; cancelRoute đua với collect. Kiểm tra invariants toàn bộ dữ liệu, không chỉ HTTP response.

### R04 — P1: Đăng ký quán công khai không xác minh chủ Zalo ID

- [POST /merchants/register](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/merchants/merchants.controller.ts:21>) là Public.
- [registerPublic](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/merchants/merchants.service.ts:45>) tạo User/Merchant từ `zalo_id`, phone, name do caller gửi, không xác minh quyền sở hữu Zalo ID. LoginScreen vẫn gọi luồng này.
- Người không đăng nhập có thể đăng ký trước Zalo ID hoặc số điện thoại của người khác, tạo hồ sơ sai và chặn đăng ký hợp lệ bởi ràng buộc unique. Không phải bằng chứng có thể lấy token của nạn nhân.
- Sửa: liên kết danh tính từ token Zalo đã xác minh hoặc session backend; không tin `zalo_id` do form tự nhập. Điều chỉnh cả luồng browser/native; giữ endpoint có public là được nếu chính endpoint xác minh proof hợp lệ trước khi ghi.
- Test: thiếu proof, proof giả, token người A đi kèm ID B không được tạo user/quán; proof hợp lệ hoạt động với ward null/PENDING.

### R05 — P1: Outbox chưa cô lập an toàn khi chuyển tài khoản hoặc nhận dữ liệu legacy

- [setOutboxOwner/claimLegacyOutboxRecords](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/lib/outbox-db.ts:120>) tự gán mọi record thiếu owner cho tài khoản đầu tiên đăng nhập, không có bằng chứng record thuộc tài khoản đó. Hàm claim đọc record ngoài transaction rồi put lại, có thể ghi đè khi các lần claim giao nhau.
- [performSync](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/lib/outbox-sync.ts:81>) chụp danh sách rồi await nhiều bước; API dùng access token hiện tại lúc gửi. Batch không giữ owner/session epoch cố định; cleanup worker không hủy batch đang chạy.
- Chuyển A sang B trong các bước await có thể gửi payload của A với token B. Backend chặn một số đơn ASSIGNED nhưng không bảo đảm cho mọi đơn READY cùng phường.
- Sửa: snapshot identity/session, kiểm tra trước mỗi lần gửi/retry, không cho batch cũ dùng phiên mới; xử lý kết quả về đúng owner. Legacy không rõ chủ phải cách ly và có đường khôi phục có xác minh, không xóa hoặc tự nhận.
- Test: đổi A/B trước send, giữa batch và trong refresh/retry; legacy chưa xác định; claim đồng thời; dữ liệu không bị mất và không đổi chủ.

### R06 — P1: Khôi phục số liệu ca và nộp trạm còn phụ thuộc outbox trên máy

- [reconcileRouteProgress](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/pages/CollectorFlow.tsx:64>) thêm ID stop COLLECTED vào bộ đếm, nhưng chỉ tạo CompletedStop từ storedCompleted/outbox.
- [serializePersistedRoute](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/orders/orders.service.ts:550>) trả trạng thái và expected liters, không trả đủ transaction ID/actual liters/kg để khôi phục số liệu đã thu.
- [StationDeliveryFlow](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/pages/StationDeliveryFlow.tsx:56>) dùng Object.values(completed); [getCandidates](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/pages/StationDeliveryFlow.tsx:463>) bắt buộc có record outbox synced kèm server_id.
- Trên máy mới hoặc mất cache, server vẫn có ca ACTIVE/stop COLLECTED nhưng tổng thực thu có thể bằng 0 và trang nộp trạm báo chưa có giao dịch. Ngay cả khi còn completed local, outbox chỉ list 100 record hoặc đã dọn retention 7 ngày cũng làm thiếu candidate.
- Sửa: tải giao dịch đã thu/chưa nộp từ server theo quyền collector, có pagination; khôi phục actual values và IDs từ server. Outbox chỉ bổ sung dữ liệu chưa được server xác nhận. Không dùng expected liters thay actual liters, không nộp lại giao dịch đã thuộc phiếu trạm.
- Test: IndexedDB và cache trống + server đã có dữ liệu; >100 record; outbox hết retention; nộp trạm idempotent; không lẫn tài khoản.

### R07 — P1: Thu hồi/cấp can có thể phá trạng thái can đang vận chuyển

- [AdminService.assignContainer](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/admin/admin.service.ts:1668>) gán state AT_MERCHANT và ACTIVE mà không kiểm tra IN_TRANSIT/đơn mở/giao dịch chưa nộp. Không đồng bộ wardId với quán được gán.
- [AdminService.unassignContainer](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/admin/admin.service.ts:1709>) đặt merchantId null, state AT_MERCHANT không xét can còn trong ca/giao dịch.
- [Nút Thu hồi](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/admin/src/components/containers-view.tsx:84>) xuất hiện cho can có merchant kể cả IN_TRANSIT.
- Admin có thể thu hồi rồi cấp can còn chứa dầu cho quán khác, làm hồ sơ can không khớp giao dịch và luồng nộp trạm.
- Sửa: tập trung luật chuyển trạng thái, kiểm tra nguyên tử các ràng buộc đơn/giao dịch, cập nhật phường nhất quán; áp dụng cả endpoint assign cũ trong ContainersService. Không sửa bằng mỗi disable nút frontend.
- Test: thu hồi/cấp khi IN_TRANSIT/đơn mở bị chặn; luồng bình thường thành công, audit và ward đúng; thao tác song song không vượt kiểm tra.

### R08 — P2: Lỗi mạng/database bị coi là phiên đăng nhập hết hạn

- [Admin AuthProvider](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/admin/src/lib/auth.tsx:24>) xóa token với mọi lỗi api.me(), kể cả mạng hoặc 5xx.
- [Shared API client](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/packages/api-client/src/index.ts:80>) nuốt mọi lỗi refresh thành null rồi xóa token.
- [JwtAuthGuard](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/auth/guards/jwt-auth.guard.ts:44>) gọi Prisma trong cùng try/catch xác thực; database unavailable cũng thành 401.
- Hậu quả: mất phiên khi reload/máy chủ tạm lỗi, người dùng bị yêu cầu đăng nhập lại dù credentials còn hợp lệ.
- Sửa: phân biệt lỗi mạng/timeout/5xx và credentials thực sự không hợp lệ; giữ token khi lỗi tạm, hiển thị retry; không mở quyền truy cập khi không xác minh được user; trả lỗi dịch vụ phù hợp thay 401 giả.
- Test: me/refresh network fail, 5xx, DB timeout và invalid/expired/revoked session thật.

### R09 — P2: Sửa thông tin quán có thể lưu một nửa dù API báo lỗi

- [MerchantsService.update](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/merchants/merchants.service.ts:228>) update merchant trước, sau đó user.phone và location ở các lệnh riêng.
- [User.phone unique](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/prisma/schema.prisma:140>) khiến bước cập nhật phone trùng bị fail sau khi tên/địa chỉ/phường hoặc trạng thái quán đã thay đổi.
- Sửa: một transaction bao gồm merchant, phone, geography; map lỗi phone conflict rõ ràng; refetch/invalidation Admin và Mini App đúng.
- Test: sửa tên kèm phone trùng phải rollback tất cả; location fail cũng rollback; chỉnh hợp lệ giữ đúng quyền và trạng thái PENDING/APPROVED.

### R10 — P2: Timeout request Mini App hết hiệu lực khi mới nhận headers

- [fetchWithTimeout](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/lib/api.ts:79>) clear timer ngay khi fetch trả Response.
- [request đọc body sau đó](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/miniapp/src/lib/api.ts:171>) gọi parseResponse/response.text() ngoài thời hạn đó.
- Server/proxy đã trả headers nhưng body bị treo khiến request vẫn chờ vô hạn, dù tên helper và test hiện tại cho cảm giác đã có timeout đầy đủ.
- Sửa: deadline bao cả fetch và đọc body, quản lý abort và listener đến khi hoàn tất; áp dụng me/refresh và request liên quan. Shared Admin client cũng cần deadline.
- Test: headers tới ngay nhưng body không bao giờ xong; caller abort sau headers; timeout không xóa token hoặc local pending.

### R11 — P2: Phân loại lỗi GPS sai và tài liệu relay mâu thuẫn

- [ZaloLocationProvider](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/modules/auth/providers/zalo-location.provider.ts:65>) gom mã lỗi provider chưa xử lý (bao gồm 116/117) thành 401 ZALO_LOCATION_TOKEN_INVALID.
- Ảnh người dùng có HTTP 200 nhưng provider_error 117. Theo [tài liệu Zalo chính thức](https://docs.zaloplatforms.com/docs/MA/api/errorCode), 117 là secret_key không hợp lệ; 116 là secret_key rỗng. Bật Location hay lấy token mới không sửa được secret sai. Chưa xác minh cấu hình live đã được chỉnh sau ảnh hay chưa.
- [Hướng dẫn profile relay](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/docs/ZALO_PROFILE_RELAY.md:26>) vẫn đặt profile/tunnel vào 8787, trong khi [code profile relay](<C:/Users/admin/OneDrive/Documents/ChatGPT/Y.E.S 2/apps/api/src/demo/zalo-profile-relay.ts:230>) mặc định 8788 và Location Relay dùng 8787.
- Sửa: mã lỗi cấu hình/provider tách khỏi token/quyền GPS; safe diagnostics giữ mã provider nhưng không log token/secret. Runbook nhất quán hai relay/hai tunnel; URL GPS có /zalo/location và health đúng dịch vụ.
- Test: 116,117,118,119, sai dịch vụ/URL/token relay, timeout, user deny. Secret thực tế do người vận hành nhập an toàn, không đưa vào prompt/Git/log.

## Kiểm tra đã thực hiện

| Nhóm | Kết quả lượt review này |
| --- | --- |
| API unit tests, bỏ e2e-spec | 23 suites, 204 tests đạt |
| Admin Vitest | 4 files, 50 tests đạt |
| Mini App Node tests | 132 tests đạt |
| Mini App lifecycle integration, jsdom/fake IndexedDB | 1 test đạt |
| API/Admin/Mini App typecheck, noEmit/incremental false | Cả 3 đạt |
| ESLint src API/Admin/Mini App, không --fix | Đạt |
| Database E2E / production migration | Không chạy |
| Production build / ZMP deploy | Không chạy trong lượt review này |
| Điện thoại thật, GPS, gọi điện, camera/QR | Chưa xác minh |

Tổng 387 tests đạt không có nghĩa các tình huống R01–R11 đã được kiểm thử. Những bộ test hiện tại có giá trị hồi quy nhưng còn các khoảng trống trên.

## Cách dùng prompt

Mở file `2026-09-08-repair-prompt.txt` cùng thư mục, copy toàn bộ và dán vào task đang sửa ECOllect. Prompt yêu cầu kiểm tra lại từng phát hiện trước khi sửa, bổ sung regression tests và chỉ dùng database test cô lập. Không cho phép tự động sửa dữ liệu production hoặc deploy.
