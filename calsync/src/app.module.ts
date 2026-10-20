import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ProvidersModule } from './providers/providers.module';
import { QueueModule } from './queue/queue.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Web process: HTTP API + webhook ingress. It PRODUCES queue jobs but does not
 * consume them — the sync processors live in the worker (worker.module.ts).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    QueueModule,
    ProvidersModule,
    WebhooksModule,
  ],
})
export class AppModule {}
