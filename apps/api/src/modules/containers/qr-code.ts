export function normalizeWardCode(code: string): string {
  return code.trim().replace(/\s+/g, '-').toUpperCase();
}

export function wardLookupKey(code: string): string {
  return normalizeWardCode(code).replace(/[^A-Z0-9]/g, '');
}

export function containerQrPrefix(wardCode: string): string {
  return `ECO-UCO-${normalizeWardCode(wardCode)}-`;
}

export function buildContainerQrCode(wardCode: string, sequence: number): string {
  return `${containerQrPrefix(wardCode)}${String(sequence).padStart(3, '0')}`;
}
