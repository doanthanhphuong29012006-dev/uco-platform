import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL')?.trim();
    this.client = redisUrl ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    }) : null;
    this.client?.on('error', () => undefined);
  }

  async onModuleInit(): Promise<void> {
    if (this.client) await this.client.connect();
  }

  async ping(): Promise<'PONG' | 'DISABLED'> {
    return this.client ? this.client.ping() : 'DISABLED';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.status !== 'end') {
      await this.client.quit();
    }
  }
}
