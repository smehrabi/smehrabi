import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ChangeState, ChangeType } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  CALENDAR_PROVIDER,
  CalendarProvider,
} from '../providers/calendar-provider.port';
import { QUEUE_INGEST, QUEUE_SYNC } from '../queue/queue.module';
import { SyncEngineService } from './sync-engine.service';

/**
 * Stage 1: turn a verified webhook into ChangeEvent rows and enqueue one sync
 * job per change. Jobs are keyed by calendar so writes to one calendar stay
 * serialized downstream.
 */
@Processor(QUEUE_INGEST)
export class IngestProcessor extends WorkerHost {
  private readonly log = new Logger(IngestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
    @InjectQueue(QUEUE_SYNC) private readonly syncQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ rawBody: string; signature: string }>): Promise<void> {
    const changes = this.provider.parseWebhook(
      job.data.rawBody,
      job.data.signature,
    );

    for (const c of changes) {
      // Resolve which of our calendars this provider calendar maps to.
      const calendars = await this.prisma.calendar.findMany({
        where: { providerCalendarId: c.providerCalendarId, syncEnabled: true },
      });

      for (const cal of calendars) {
        const changeType = c.type as ChangeType;
        // Idempotency: unique (calendarId, providerEventId, providerSeq) drops
        // reprocessing of the same provider version.
        const row = await this.prisma.changeEvent
          .create({
            data: {
              tenantId: cal.tenantId,
              calendarId: cal.id,
              providerEventId: c.providerEventId,
              changeType,
              providerSeq: c.seq ?? null,
            },
          })
          .catch((err: any) => {
            if (err?.code === 'P2002') return null; // duplicate version
            throw err;
          });
        if (!row) continue;

        await this.syncQueue.add(
          'change',
          { changeEventId: row.id },
          {
            removeOnComplete: true,
            attempts: 8,
            backoff: { type: 'exponential', delay: 2000 },
          },
        );
      }
    }
  }
}

/** Stage 2: execute the sync algorithm for one ChangeEvent. */
@Processor(QUEUE_SYNC)
export class SyncProcessor extends WorkerHost {
  private readonly log = new Logger(SyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SyncEngineService,
  ) {
    super();
  }

  async process(job: Job<{ changeEventId: string }>): Promise<void> {
    const ce = await this.prisma.changeEvent.findUnique({
      where: { id: job.data.changeEventId },
    });
    if (!ce || ce.state === ChangeState.done) return;

    await this.prisma.changeEvent.update({
      where: { id: ce.id },
      data: { state: ChangeState.processing, attempts: { increment: 1 } },
    });

    try {
      await this.engine.processChange({
        tenantId: ce.tenantId,
        calendarId: ce.calendarId,
        providerEventId: ce.providerEventId,
        changeType: ce.changeType,
      });
      await this.prisma.changeEvent.update({
        where: { id: ce.id },
        data: { state: ChangeState.done },
      });
    } catch (err: any) {
      this.log.error(`Sync failed for change ${ce.id}: ${err?.message}`);
      await this.prisma.changeEvent.update({
        where: { id: ce.id },
        data: { state: ChangeState.failed, error: String(err?.message ?? err) },
      });
      throw err; // let BullMQ retry with backoff
    }
  }
}
