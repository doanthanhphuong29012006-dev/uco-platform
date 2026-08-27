import { Injectable } from '@nestjs/common';
import type { IZaloAuthProvider } from './zalo-auth.provider';

@Injectable()
export class MockZaloAuthProvider implements IZaloAuthProvider {
  async verify(code: string): Promise<{ zaloId: string; phone: string; name?: string }> {
    return {
      zaloId: code,
      phone: '0000000000',
      name: undefined,
    };
  }
}
