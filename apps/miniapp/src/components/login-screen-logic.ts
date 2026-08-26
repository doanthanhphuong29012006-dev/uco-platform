import type { DevAccount } from '@eco-oil/shared-types';

export function shouldShowDevelopmentLogin(backendMockDetected: boolean, sdkUnavailable: boolean): boolean {
  return backendMockDetected || sdkUnavailable;
}

export function getSeedLoginCredentials(accounts: DevAccount[], selectedId: string): { zaloId: string; phone: string } | null {
  const account = accounts.find((item) => item.zalo_id === selectedId);
  return account?.phone ? { zaloId: account.zalo_id, phone: account.phone } : null;
}
