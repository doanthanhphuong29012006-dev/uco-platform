import { expect, test } from 'vitest';
import { normalizeVietnamesePhoneNumber, validateMerchantEdit } from './merchant-edit';

test.each([
  ['0901 234 567', '+84901234567'],
  ['84.901.234.567', '+84901234567'],
  ['+84-901-234-567', '+84901234567'],
])('normalizes Vietnamese phone %s', (input, expected) => {
  expect(normalizeVietnamesePhoneNumber(input)).toBe(expected);
});

test('validates and creates the Admin merchant PATCH payload', () => {
  expect(validateMerchantEdit({
    name: ' Quán mới ',
    phone: '0901 234 567',
    address: ' 1 Đường Mới ',
    businessType: ' Nhà hàng ',
    wardId: 'ward-1',
    lat: '10,7769',
    lng: '106.7009',
  })).toEqual({
    ok: true,
    payload: {
      name: 'Quán mới',
      phone: '+84901234567',
      address: '1 Đường Mới',
      business_type: 'Nhà hàng',
      ward_id: 'ward-1',
      lat: 10.7769,
      lng: 106.7009,
    },
  });
});

test('rejects missing name and invalid Vietnamese phone', () => {
  const base = { name: 'Quán', phone: '0901234567', address: 'Địa chỉ', businessType: '', wardId: 'ward-1', lat: '', lng: '' };
  expect(validateMerchantEdit({ ...base, name: ' ' })).toMatchObject({ ok: false, message: 'Tên quán là bắt buộc.' });
  expect(validateMerchantEdit({ ...base, phone: '12345' })).toMatchObject({ ok: false, message: 'Số điện thoại Việt Nam không hợp lệ.' });
});
