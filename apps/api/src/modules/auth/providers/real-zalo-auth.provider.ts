import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IZaloAuthProvider } from './zalo-auth.provider';

@Injectable()
export class RealZaloAuthProvider implements IZaloAuthProvider {
  async verify(code: string): Promise<{ zaloId: string; phone: string; name?: string }> {
    // TODO: gọi Zalo Graph API với app_id/app_secret khi production OAuth được cấu hình.
    void code;
    throw new ServiceUnavailableException('Real Zalo OAuth provider is not configured');
  }
}
