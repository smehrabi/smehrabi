import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Minimal Redis distributed mutex used to serialize all writes to a single
 * target calendar. This is the structural reason our own write-echo is seen as
 * a no-op: by the time the echo webhook is processed, the EventLink hash has
 * already been committed under the lock.
 *
 * NOTE: this is a single-node SET NX lock, adequate for MVP. For multi-replica
 * production, move to Redlock or a fencing-token scheme.
 */
@Injectable()
export class LockService {
  private readonly log = new Logger(LockService.name);
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }

  async withCalendarLock<T>(
    calendarId: string,
    fn: () => Promise<T>,
    opts: { ttlMs?: number; retryMs?: number; maxWaitMs?: number } = {},
  ): Promise<T> {
    const key = `lock:cal:${calendarId}`;
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const ttl = opts.ttlMs ?? 30_000;
    const retry = opts.retryMs ?? 100;
    const maxWait = opts.maxWaitMs ?? 30_000;

    const deadline = Date.now() + maxWait;
    while (!(await this.acquire(key, token, ttl))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring calendar lock ${calendarId}`);
      }
      await new Promise((r) => setTimeout(r, retry));
    }

    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }

  private async acquire(key: string, token: string, ttl: number): Promise<boolean> {
    const res = await this.redis.set(key, token, 'PX', ttl, 'NX');
    return res === 'OK';
  }

  private async release(key: string, token: string): Promise<void> {
    // Only release if we still own the lock (compare-and-delete).
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await this.redis.eval(script, 1, key, token);
  }
}
