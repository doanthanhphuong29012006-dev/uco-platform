# Zalo location demo relay

Zalo Open API từ chối giải mã dữ liệu vị trí cá nhân khi request xuất phát từ IP ngoài Việt Nam (`error: -501`). Relay này chỉ dành cho demo: Render vẫn phục vụ API chính, còn request giải mã location token được chuyển qua máy tính ở Việt Nam.

## Bảo mật

- App Secret chỉ đặt trong tiến trình relay trên máy Việt Nam.
- Endpoint công khai bắt buộc Bearer token tối thiểu 32 ký tự.
- Relay không log access token, location token hoặc App Secret.
- Không đưa App Secret vào Mini App, Git hoặc ảnh chụp màn hình.
- Quick Tunnel thay URL sau mỗi lần chạy; không dùng như hạ tầng production.

## 1. Chuẩn bị Cloudflare Tunnel

Tải `cloudflared-windows-amd64.exe` từ trang phát hành chính thức của Cloudflare, lưu thành:

```text
.tools/cloudflared.exe
```

Thư mục `.tools` đã được gitignore.

## 2. Chạy relay trong PowerShell thứ nhất

Tạo relay token và nhập App Secret mà không ghi secret vào lịch sử lệnh:

```powershell
$relayToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:ZALO_LOCATION_RELAY_TOKEN = $relayToken
$secureSecret = Read-Host 'ZALO_APP_SECRET' -AsSecureString
$env:ZALO_APP_SECRET = [Net.NetworkCredential]::new('', $secureSecret).Password
$relayToken
pnpm demo:zalo-location-relay
```

Sao chép giá trị `$relayToken` để dùng tại Render. Không đóng cửa sổ này trong lúc demo.

Relay chỉ lắng nghe tại `http://127.0.0.1:8787`.

## 3. Mở HTTPS tunnel trong PowerShell thứ hai

```powershell
.\.tools\cloudflared.exe tunnel --url http://127.0.0.1:8787
```

Cloudflare in ra URL ngẫu nhiên dạng `https://...trycloudflare.com`. Kiểm tra:

```text
https://...trycloudflare.com/health
```

Kết quả đúng là `{"status":"ok"}`.

## 4. Cấu hình Render

Trong service `eco-oil-api`, thêm hoặc cập nhật:

```text
ZALO_LOCATION_RELAY_URL=https://...trycloudflare.com/zalo/location
ZALO_LOCATION_RELAY_TOKEN=<giá trị $relayToken ở bước 2>
```

Lưu Environment để Render deploy lại. Không cần deploy ZMP.

## 5. Kiểm tra trên Zalo

1. Chờ Render báo Live.
2. Tắt hẳn và mở lại Zalo Mini App Development.
3. Vào Tuyến hôm nay và nhấn làm mới.
4. Kết quả đúng: banner fallback GPS biến mất, hiện thời gian cập nhật GPS và khoảng cách tuyến được tính lại.

Khi kết thúc demo, xóa `ZALO_LOCATION_RELAY_URL` và `ZALO_LOCATION_RELAY_TOKEN` khỏi Render hoặc dừng tunnel. Với production, chuyển relay sang backend có IP Việt Nam cố định.
