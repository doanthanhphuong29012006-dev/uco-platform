# Runbook trình diễn Eco-Oil

Tài liệu này dùng cho bản demo đang chạy với:

- API trên Render
- PostgreSQL trên Neon
- Redis trên Upstash
- Mini App/Admin trên Vercel
- Zalo Mini App Development
- Relay GPS chạy trên máy tính tại Việt Nam qua Cloudflare Quick Tunnel

Quick Tunnel chỉ dành cho demo. URL `trycloudflare.com` thay đổi sau mỗi lần chạy lại.

## Những thứ cần chuẩn bị

- Máy tính có Internet và không bật VPN ra nước ngoài.
- Zalo trên điện thoại đã cấp quyền vị trí cho Eco-Oil.
- Tài khoản có quyền Developer của Eco Oil.
- `ZALO_APP_SECRET` lấy từ Zalo for Developers. Không lưu secret vào source, ảnh chụp hoặc chat.
- File `.tools/cloudflared.exe` đã tồn tại trong repo.
- Render đang có hai biến `ZALO_LOCATION_RELAY_URL` và `ZALO_LOCATION_RELAY_TOKEN`.

## Mỗi lần cần trình diễn

### 1. Đánh thức API Render

Mở URL health trước buổi demo vài phút:

```text
https://eco-oil-api.onrender.com/health
```

Render Free có thể mất khoảng 50 giây để khởi động sau thời gian không hoạt động.

### 2. Chạy GPS relay — PowerShell thứ nhất

```powershell
cd "C:\Users\admin\OneDrive\Documents\ChatGPT\Y.E.S 2"
$relayToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:ZALO_LOCATION_RELAY_TOKEN = $relayToken
$relayToken | Set-Clipboard
$secureSecret = Read-Host 'Nhap ZALO_APP_SECRET' -AsSecureString
$env:ZALO_APP_SECRET = [Net.NetworkCredential]::new('', $secureSecret).Password
pnpm demo:zalo-location-relay
```

Kết quả đúng:

```text
[zalo-location-relay] listening on http://127.0.0.1:8787
```

Relay token đang nằm trong clipboard. Không đóng cửa sổ này trong lúc demo.

### 3. Mở Cloudflare Tunnel — PowerShell thứ hai

```powershell
& "C:\Users\admin\OneDrive\Documents\ChatGPT\Y.E.S 2\.tools\cloudflared.exe" tunnel --url http://127.0.0.1:8787
```

Tìm URL dạng:

```text
https://<ten-ngau-nhien>.trycloudflare.com
```

Kiểm tra trên trình duyệt:

```text
https://<ten-ngau-nhien>.trycloudflare.com/health
```

Kết quả đúng là `{"status":"ok"}`. Không đóng cửa sổ tunnel.

### 4. Cập nhật Render

Vào Render > `eco-oil-api` > **Environment** và cập nhật:

```text
ZALO_LOCATION_RELAY_TOKEN=<relay token vừa tạo>
ZALO_LOCATION_RELAY_URL=https://<ten-ngau-nhien>.trycloudflare.com/zalo/location
```

Nhấn **Save Changes** và chờ service báo **Live**. Không đặt App Secret vào hai biến trên.

### 5. Mở Mini App

- Nếu source Mini App không đổi: dùng QR Development của phiên bản gần nhất trong Mini App Center; không cần deploy lại.
- Nếu không còn QR hoặc cần tạo phiên bản Development mới, chạy phần “Deploy Mini App khi có code mới” bên dưới.
- Tắt hẳn Eco-Oil trên điện thoại, mở lại, vào **Tuyến hôm nay** và nhấn nút làm mới.

Kết quả GPS đúng:

- Không còn cảnh báo đang dùng vị trí trung tâm phường.
- Hiện `Đã cập nhật GPS và tuyến lúc HH:mm`.
- Khoảng cách và thứ tự điểm được tính lại từ vị trí thật.

## Deploy Mini App khi có code mới

Không chạy bước này chỉ vì URL Quick Tunnel thay đổi; URL relay nằm ở Render, không nằm trong bundle Mini App.

```powershell
cd "C:\Users\admin\OneDrive\Documents\ChatGPT\Y.E.S 2\apps\miniapp"
pnpm build:zmp
npx --yes zmp-cli@4.0.3 deploy --existing --outputDir dist
```

Khi CLI hỏi, chọn:

- Project: `Eco Oil`
- Mini App ID: `2013689159096493937`
- Version status: `Development`
- Description: mô tả ngắn thay đổi vừa làm

Quét QR mới bằng Zalo. `zmp start` không dùng được cho repo static hiện tại vì CLI không nhận đây là project ZMP chuẩn.

## Khi backend có code mới

```powershell
cd "C:\Users\admin\OneDrive\Documents\ChatGPT\Y.E.S 2"
git push origin main
```

Render tự deploy từ `main`. Nếu thay đổi có Prisma migration, phải chạy migration Neon trước khi push theo hướng dẫn trong `DEPLOY.md`.

## Trình tự demo đề xuất

1. Mở collector và lấy GPS thật.
2. Giới thiệu AI dự báo tổng thể tích và rủi ro sức chứa xe.
3. Giới thiệu AI tối ưu thứ tự tuyến.
4. Mở một điểm thu gom, xem AI dự báo sản lượng.
5. Nhập số lít thực tế để trình diễn cảnh báo chênh lệch AI.
6. Xác nhận thu gom và chứng minh giao dịch vẫn lưu khi mạng chập chờn.
7. Giao dầu về trạm và mở Admin để xem đối soát/cảnh báo.

## Khi kết thúc demo

- Nhấn `Ctrl+C` tại PowerShell relay.
- Nhấn `Ctrl+C` tại PowerShell Cloudflare Tunnel.
- Lần chạy sau phải tạo token mới, lấy URL tunnel mới và cập nhật lại hai biến trên Render.
- Không xóa App Secret, database hoặc bản Development trên Zalo.

## Xử lý nhanh lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `ZALO_APP_SECRET is required` | Chạy lại dòng `Read-Host`, nhập secret rồi gán vào `$env:ZALO_APP_SECRET` trước khi chạy relay. |
| Mở `127.0.0.1:8787/` thấy `NOT_FOUND` | Dùng `/health`; đường dẫn gốc không có route. |
| Render Live nhưng GPS vẫn fallback | Kiểm tra hai PowerShell còn chạy, tunnel `/health` trả `ok`, URL Render có đuôi `/zalo/location`. |
| Link `zalo.me/s/...` báo ứng dụng đang phát triển | Dùng QR Development, không dùng link public trước khi app được phát hành. |
| `This is not ZMP project` khi chạy `zmp start` | Dùng quy trình `build:zmp` + `deploy --existing --outputDir dist` ở trên. |
| Render trả chậm lần đầu | Mở endpoint health trước demo và chờ instance thức dậy. |
