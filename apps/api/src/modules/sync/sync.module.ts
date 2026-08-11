import { Module } from '@nestjs/common';
import { CollectionsModule } from '../collections/collections.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [CollectionsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
