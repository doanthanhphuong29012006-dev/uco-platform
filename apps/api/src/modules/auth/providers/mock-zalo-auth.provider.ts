import { Injectable } from '@nestjs/common';
import type { IZaloAuthProvider } from './zalo-auth.provider';

@Injectable()
export class MockZaloAuthProvider implements IZaloAuthProvider {
  async exchangeCode(code: string, codeVerifier: string) {
    void codeVerifier;
    return { accessToken: code, refreshToken: `mock-refresh-${code}`, expiresIn: 3600 };
  }

  async verify(code: string): Promise<{ zaloId: string; phone: string | null; name?: string }> {
    return {
      zaloId: code,
      phone: '0000000000',
      name: undefined,
    };
  }
}
