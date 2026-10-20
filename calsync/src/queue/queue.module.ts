import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { LockService } from './lock.service';

/** Queue names shared by producers (web) and consumers (worker). */
export const QUEUE_INGEST = 'ingest'; // webhook payload -> change_event rows
export const QUEUE_SYNC = 'sync'; // one job per change_event

function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection() }),
    BullModule.registerQueue(
      { name: QUEUE_INGEST },
      { name: QUEUE_SYNC },
    ),
  ],
  providers: [LockService],
  exports: [BullModule, LockService],
})
export class QueueModule {}
