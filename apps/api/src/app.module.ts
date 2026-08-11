import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CollectorsModule } from './modules/collectors/collectors.module';
import { ContainersModule } from './modules/containers/containers.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { OrdersModule } from './modules/orders/orders.module';
import { StationsModule } from './modules/stations/stations.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StationDeliveriesModule } from './modules/station-deliveries/station-deliveries.module';
import { SyncModule } from './modules/sync/sync.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    MerchantsModule,
    OrdersModule,
    CollectorsModule,
    StationsModule,
    ContainersModule,
    CollectionsModule,
    StationDeliveriesModule,
    SyncModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
