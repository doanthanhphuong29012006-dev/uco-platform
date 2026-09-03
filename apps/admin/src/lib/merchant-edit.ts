export interface MerchantEditFormValues {
  name: string;
  phone: string;
  address: string;
  businessType: string;
  wardId: string;
  lat: string;
  lng: string;
}

export interface MerchantUpdatePayload {
  name: string;
  phone: string;
  address: string;
  business_type?: string;
  ward_id: string;
  lat?: number;
  lng?: number;
}

export function normalizeVietnamesePhoneNumber(value: string): string | null {
  const normalized = value.trim().replace(/[\s().-]/g, '');
  if (/^0\d{9}$/.test(normalized)) return `+84${normalized.slice(1)}`;
  if (/^84\d{9}$/.test(normalized)) return `+${normalized}`;
  if (/^\+84\d{9}$/.test(normalized)) return normalized;
  return null;
}

export function validateMerchantEdit(values: MerchantEditFormValues):
  | { ok: true; payload: MerchantUpdatePayload }
  | { ok: false; message: string } {
  const name = values.name.trim();
  if (!name) return { ok: false, message: 'Tên quán là bắt buộc.' };
  const phone = normalizeVietnamesePhoneNumber(values.phone);
  if (!phone) return { ok: false, message: 'Số điện thoại Việt Nam không hợp lệ.' };
  const address = values.address.trim();
  if (!address) return { ok: false, message: 'Địa chỉ là bắt buộc.' };
  if (!values.wardId) return { ok: false, message: 'Phường là bắt buộc.' };

  const latText = values.lat.trim();
  const lngText = values.lng.trim();
  if ((latText && !lngText) || (!latText && lngText)) {
    return { ok: false, message: 'Cần nhập cả vĩ độ và kinh độ.' };
  }

  let coordinates: { lat?: number; lng?: number } = {};
  if (latText && lngText) {
    const lat = Number(latText.replace(',', '.'));
    const lng = Number(lngText.replace(',', '.'));
    if (!Number.isFinite(lat) || lat < 8 || lat > 24 || !Number.isFinite(lng) || lng < 102 || lng > 110) {
      return { ok: false, message: 'Tọa độ phải hợp lệ và nằm trong phạm vi Việt Nam.' };
    }
    coordinates = { lat, lng };
  }

  const businessType = values.businessType.trim();
  return {
    ok: true,
    payload: {
      name,
      phone,
      address,
      ...(businessType ? { business_type: businessType } : {}),
      ward_id: values.wardId,
      ...coordinates,
    },
  };
}
