import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CollectorsModule } from './modules/collectors/collectors.module';
import { ContainersModule } from './modules/containers/containers.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { StationsModule } from './modules/stations/stations.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

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
    CollectorsModule,
    StationsModule,
    ContainersModule,
    HealthModule,
  ],
})
export class AppModule {}
