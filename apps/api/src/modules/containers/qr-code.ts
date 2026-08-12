export function normalizeWardCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function containerQrPrefix(wardCode: string): string {
  return `ECO-UCO-${normalizeWardCode(wardCode)}-`;
}

export function buildContainerQrCode(wardCode: string, sequence: number): string {
  return `${containerQrPrefix(wardCode)}${String(sequence).padStart(4, '0')}`;
}
