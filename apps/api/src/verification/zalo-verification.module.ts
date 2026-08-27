import { Module } from '@nestjs/common';
import { ZaloVerificationController } from './zalo-verification.controller';

@Module({
  controllers: [ZaloVerificationController],
})
export class ZaloVerificationModule {}
