import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get()
  async check(): Promise<{
    status: 'ok' | 'error';
    service: string;
    db: 'ok' | 'error';
    redis: 'ok' | 'error';
  }> {
    const [dbResult, redisResult] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const db = dbResult.status === 'fulfilled' ? 'ok' : 'error';
    const redis = redisResult.status === 'fulfilled' && redisResult.value === 'PONG' ? 'ok' : 'error';
    const status = db === 'ok' && redis === 'ok' ? 'ok' : 'error';

    if (status === 'error') {
      throw new ServiceUnavailableException({
        status,
        service: 'eco-oil-api',
        db,
        redis,
      });
    }

    return {
      status,
      service: 'eco-oil-api',
      db,
      redis,
    };
  }
}
