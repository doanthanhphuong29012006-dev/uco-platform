import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CollectorsController } from './collectors.controller';
import { CollectorsService } from './collectors.service';

@Module({
  imports: [PrismaModule],
  controllers: [CollectorsController],
  providers: [CollectorsService],
})
export class CollectorsModule {}
