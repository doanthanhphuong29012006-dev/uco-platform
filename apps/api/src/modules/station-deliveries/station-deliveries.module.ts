import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StationDeliveriesController } from './station-deliveries.controller';
import { StationDeliveriesService } from './station-deliveries.service';

@Module({
  imports: [PrismaModule],
  controllers: [StationDeliveriesController],
  providers: [StationDeliveriesService],
})
export class StationDeliveriesModule {}
