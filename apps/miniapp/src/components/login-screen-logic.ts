import { Role } from '@eco-oil/shared-types';
import type { AuthUser, DevAccount } from '@eco-oil/shared-types';

export function shouldShowDevelopmentLogin(backendMockDetected: boolean, sdkUnavailable: boolean): boolean {
  return backendMockDetected || sdkUnavailable;
}

export function getSeedLoginCredentials(accounts: DevAccount[], selectedId: string): { zaloId: string; phone: string } | null {
  const account = accounts.find((item) => item.zalo_id === selectedId);
  return account?.phone ? { zaloId: account.zalo_id, phone: account.phone } : null;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidAuthUser(user: unknown): user is AuthUser {
  if (typeof user !== 'object' || user === null) return false;
  const identity = user as Partial<AuthUser>;
  if (!hasText(identity.id) || !hasText(identity.zalo_id) || !hasText(identity.role)) return false;
  if (!Object.values(Role).includes(identity.role as Role)) return false;
  if (identity.role === Role.MERCHANT) return hasText(identity.merchantId);
  if (identity.role === Role.COLLECTOR) return hasText(identity.collectorId);
  return true;
}
