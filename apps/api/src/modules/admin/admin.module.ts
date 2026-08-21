import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StationsService } from '../stations/stations.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, StationsService],
})
export class AdminModule {}
