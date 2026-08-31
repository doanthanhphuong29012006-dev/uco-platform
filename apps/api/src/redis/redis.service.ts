import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL')?.trim();
    this.client = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        })
      : null;
    this.client?.on('error', () => undefined);
  }

  async onModuleInit(): Promise<void> {
    if (this.client) await this.client.connect();
  }

  async ping(): Promise<'PONG' | 'DISABLED'> {
    return this.client ? this.client.ping() : 'DISABLED';
  }

  async setOneTime(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.client) throw new Error('Redis is not configured');
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    if (result !== 'OK') throw new Error('Redis one-time key was not created');
  }

  async setExpiring(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.client) throw new Error('Redis is not configured');
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async getValue(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis is not configured');
    return this.client.get(key);
  }

  async consumeOneTime(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis is not configured');
    const value = await this.client.eval(
      'local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); end; return value',
      1,
      key,
    );
    return typeof value === 'string' ? value : null;
  }

  async deleteOneTime(key: string): Promise<void> {
    if (!this.client) throw new Error('Redis is not configured');
    await this.client.del(key);
  }

  async restoreOneTime(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.client) throw new Error('Redis is not configured');
    if (ttlSeconds <= 0) return;
    await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.status !== 'end') {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
    }
  }
}
