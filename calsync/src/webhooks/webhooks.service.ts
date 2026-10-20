import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  CALENDAR_PROVIDER,
  CalendarProvider,
} from '../providers/calendar-provider.port';
import { QUEUE_INGEST } from '../queue/queue.module';

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
    @InjectQueue(QUEUE_INGEST) private readonly ingestQueue: Queue,
  ) {}

  async ingest(rawBody: string, signature: string): Promise<void> {
    const valid =
      'verifySignature' in this.provider &&
      (this.provider as any).verifySignature(rawBody, signature);

    // Dedup on a content hash so provider replays are dropped at the door.
    const dedupKey = createHash('sha256')
      .update(rawBody)
      .update(signature)
      .digest('hex');

    try {
      await this.prisma.webhookDelivery.create({
        data: {
          aggregator: this.provider.name,
          rawPayload: JSON.parse(rawBody || '{}'),
          signatureValid: Boolean(valid),
          dedupKey,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Unique violation on dedupKey -> duplicate delivery, already queued.
        return;
      }
      throw err;
    }

    if (!valid) {
      this.log.warn('Persisted webhook with invalid signature; not enqueued');
      return;
    }

    await this.ingestQueue.add(
      'parse',
      { rawBody, signature },
      { removeOnComplete: true, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    );
  }
}
