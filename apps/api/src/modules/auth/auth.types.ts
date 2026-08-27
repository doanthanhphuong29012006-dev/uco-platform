import type { Role } from '@prisma/client';
import type { MerchantApprovalStatus } from '@prisma/client';
import type { Request } from 'express';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  merchantId?: string;
  collectorId?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

export interface AuthUserResponse {
  id: string;
  zalo_id: string;
  phone: string | null;
  name: string | null;
  role: Role;
  merchantId: string | null;
  collectorId: string | null;
  merchantApprovalStatus: MerchantApprovalStatus | null;
  merchantRejectionReason: string | null;
}
