export function outboxErrorMessage(error: string | null): string {
  if (!error) return 'Chưa có thông tin lỗi.';
  const normalized = error.toLowerCase();
  if (normalized.includes('payload_too_large') || normalized.includes('vượt giới hạn')) {
    return 'Ảnh hoặc dữ liệu giao dịch vượt giới hạn máy chủ. Hãy giảm kích thước ảnh rồi thử lại.';
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('fetch')) {
    return 'Không kết nối được máy chủ. Dữ liệu vẫn được lưu an toàn trên máy, hãy thử lại khi có mạng.';
  }
  if (normalized.includes('validation_error')) {
    return 'Dữ liệu giao dịch không hợp lệ. Hãy mở hàng chờ để kiểm tra và thử lại.';
  }
  if (normalized.includes('internal_server_error') || normalized.includes('http_error')) {
    return 'Máy chủ chưa xử lý được giao dịch. Hãy thử lại hoặc báo cho quản trị viên.';
  }
  return 'Giao dịch chưa được đồng bộ. Hãy mở hàng chờ để xem chi tiết và thử lại.';
}
