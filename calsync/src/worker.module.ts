import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ProvidersModule } from './providers/providers.module';
import { QueueModule } from './queue/queue.module';
import { SyncModule } from './sync/sync.module';

/**
 * Worker process: CONSUMES the ingest + sync queues and runs the engine.
 * Scaled independently of the web process.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    QueueModule,
    ProvidersModule,
    SyncModule,
  ],
})
export class WorkerModule {}
