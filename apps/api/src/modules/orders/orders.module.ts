import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { RoutesController } from './routes.controller';

@Module({
  imports: [PrismaModule],
  controllers: [OrdersController, RoutesController],
  providers: [OrdersService],
})
export class OrdersModule {}
