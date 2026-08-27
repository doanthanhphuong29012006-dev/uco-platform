import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Public } from '../modules/auth/decorators/public.decorator';
import { ZALO_VERIFIER_PATH } from './zalo-verification.constants';

const VERIFICATION_FILE = join(__dirname, '../../public', ZALO_VERIFIER_PATH);

@Controller()
export class ZaloVerificationController {
  @Public()
  @Get(ZALO_VERIFIER_PATH)
  @Header('Content-Type', 'text/html; charset=utf-8')
  serveVerificationFile(): string {
    return readFileSync(VERIFICATION_FILE, 'utf8').replace(/\r?\n$/, '');
  }
}
