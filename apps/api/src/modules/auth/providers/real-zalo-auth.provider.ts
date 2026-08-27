import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IZaloAuthProvider } from './zalo-auth.provider';

@Injectable()
export class RealZaloAuthProvider implements IZaloAuthProvider {
  async verify(code: string): Promise<{ zaloId: string; phone: string; name?: string }> {
    // TODO(sprint-4): Integrate Zalo Graph API with app_id/app_secret from the deployment secret manager.
    void code;
    throw new ServiceUnavailableException('Real Zalo OAuth provider is not configured');
  }
}
