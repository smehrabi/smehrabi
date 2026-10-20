import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ChangeType,
  EventLink,
  PrivacyLevel,
  SyncLink,
  SyncLinkStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CALENDAR_PROVIDER,
  CalendarProvider,
  CalendarRef,
} from '../providers/calendar-provider.port';
import { CanonicalEvent } from '../providers/canonical-event';
import { LockService } from '../queue/lock.service';
import { contentHash } from './content-hash';
import { isManagedMirror, transformForPrivacy } from './privacy';

/** A unit of work handed to the engine (built from a ChangeEvent row). */
export interface ChangeJob {
  tenantId: string;
  calendarId: string;
  providerEventId: string;
  changeType: ChangeType;
}

/**
 * The core sync algorithm. Propagation is strictly ONE HOP, origin -> mirror.
 * Three independent loop guards (metadata tag, mirror-id lookup, content hash)
 * plus per-target-calendar write serialization make mesh loops impossible.
 */
@Injectable()
export class SyncEngineService {
  private readonly log = new Logger(SyncEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
  ) {}

  async processChange(job: ChangeJob): Promise<void> {
    const sourceCalendar = await this.prisma.calendar.findUniqueOrThrow({
      where: { id: job.calendarId },
      include: { connectedAccount: true },
    });
    const sourceRef: CalendarRef = {
      grantId: sourceCalendar.connectedAccount.aggregatorGrantId,
      providerCalendarId: sourceCalendar.providerCalendarId,
    };

    // ----- Loop-prevention gate #1: is this event a mirror WE made? -----
    const asMirror = await this.prisma.eventLink.findFirst({
      where: { mirrorProviderEventId: job.providerEventId },
    });

    if (job.changeType === ChangeType.deleted) {
      await this.handleDelete(job, asMirror);
      return;
    }

    const event = await this.provider.getEvent(sourceRef, job.providerEventId);

    // Guard #1 (continued): a tagged mirror, or one we have a row for, is a
    // TERMINAL node. Never fan out from it. If a user edited it directly,
    // revert it from the origin instead of propagating.
    if (isManagedMirror(event) || asMirror) {
      await this.handleMirrorTouched(asMirror, sourceRef, event);
      return;
    }

    // ----- This is an origin event: fan out to all active outgoing links. ---
    const links = await this.prisma.syncLink.findMany({
      where: {
        sourceCalendarId: sourceCalendar.id,
        status: { in: [SyncLinkStatus.active, SyncLinkStatus.backfilling] },
      },
    });

    for (const link of links) {
      await this.applyToTarget(link, sourceCalendar.id, event);
    }
  }

  /** Transform + idempotently write one origin event into one target link. */
  private async applyToTarget(
    link: SyncLink,
    originCalendarId: string,
    origin: CanonicalEvent,
  ): Promise<void> {
    const target = await this.prisma.calendar.findUniqueOrThrow({
      where: { id: link.targetCalendarId },
      include: { connectedAccount: true },
    });
    const targetRef: CalendarRef = {
      grantId: target.connectedAccount.aggregatorGrantId,
      providerCalendarId: target.providerCalendarId,
    };

    const existing = await this.prisma.eventLink.findUnique({
      where: {
        syncLinkId_originProviderEventId_originRecurrenceId: {
          syncLinkId: link.id,
          originProviderEventId: origin.providerEventId,
          originRecurrenceId: origin.recurrenceId ?? '',
        },
      },
    });

    // ----- Free/transparent filter -----
    // Events that show as Free shouldn't create a Busy block unless the link
    // opts in. If one already exists, remove it.
    if (!origin.busy && !link.includeTransparent) {
      if (existing) await this.deleteMirror(link, existing, targetRef);
      return;
    }

    const payload = transformForPrivacy(origin, link.privacyLevel, {
      syncLinkId: link.id,
      originAccount: link.sourceCalendarId,
      eventLinkId: existing?.id,
    });
    const hash = contentHash(payload);

    // Serialize all writes to a given target calendar so our own write-echo
    // arrives AFTER the hash is stored and is then recognized as a no-op.
    await this.locks.withCalendarLock(target.id, async () => {
      if (
        existing &&
        existing.contentHash === hash &&
        existing.appliedPrivacyLevel === link.privacyLevel
      ) {
        // ----- Loop-prevention guard #3: content-hash no-op. -----
        return;
      }

      if (!existing) {
        const mirrorId = await this.provider.createEvent(targetRef, payload);
        await this.prisma.eventLink.create({
          data: {
            tenantId: link.tenantId,
            syncLinkId: link.id,
            originCalendarId,
            originProviderEventId: origin.providerEventId,
            originMasterId: origin.masterId ?? null,
            originRecurrenceId: origin.recurrenceId ?? '',
            mirrorCalendarId: target.id,
            mirrorProviderEventId: mirrorId,
            appliedPrivacyLevel: link.privacyLevel,
            contentHash: hash,
            originSeq: origin.seq ?? null,
          },
        });
      } else {
        await this.provider.updateEvent(
          targetRef,
          existing.mirrorProviderEventId,
          payload,
        );
        await this.prisma.eventLink.update({
          where: { id: existing.id },
          data: {
            contentHash: hash,
            appliedPrivacyLevel: link.privacyLevel,
            originSeq: origin.seq ?? null,
          },
        });
      }
    });
  }

  /** Origin deleted: tear down every mirror derived from it. */
  private async handleDelete(
    job: ChangeJob,
    asMirror: EventLink | null,
  ): Promise<void> {
    if (asMirror) {
      // A mirror was deleted (by us or the user). Drop its row; never fan out.
      await this.prisma.eventLink.deleteMany({
        where: { mirrorProviderEventId: job.providerEventId },
      });
      return;
    }

    const links = await this.prisma.eventLink.findMany({
      where: {
        originCalendarId: job.calendarId,
        originProviderEventId: job.providerEventId,
      },
      include: { syncLink: true },
    });

    for (const el of links) {
      const target = await this.prisma.calendar.findUniqueOrThrow({
        where: { id: el.mirrorCalendarId },
        include: { connectedAccount: true },
      });
      await this.deleteMirror(
        el.syncLink,
        el,
        {
          grantId: target.connectedAccount.aggregatorGrantId,
          providerCalendarId: target.providerCalendarId,
        },
      );
    }
  }

  private async deleteMirror(
    link: SyncLink,
    el: EventLink,
    targetRef: CalendarRef,
  ): Promise<void> {
    await this.locks.withCalendarLock(el.mirrorCalendarId, async () => {
      // Idempotent: provider driver treats a 404 as success.
      await this.provider.deleteEvent(targetRef, el.mirrorProviderEventId);
      await this.prisma.eventLink.delete({ where: { id: el.id } });
    });
  }

  /**
   * A mirror event changed. If it was our own write (hash matches), it's the
   * echo -> ignore. If a user edited the mirror directly, revert it from the
   * origin (mirrors are read-only shadows). Either way, NEVER propagate onward.
   */
  private async handleMirrorTouched(
    asMirror: EventLink | null,
    _ref: CalendarRef,
    current: CanonicalEvent,
  ): Promise<void> {
    if (!asMirror) return; // tagged but untracked; safest to ignore

    const link = await this.prisma.syncLink.findUniqueOrThrow({
      where: { id: asMirror.syncLinkId },
    });
    const expected = transformForPrivacy(current, link.privacyLevel, {
      syncLinkId: link.id,
      originAccount: link.sourceCalendarId,
      eventLinkId: asMirror.id,
    });
    if (contentHash(expected) === asMirror.contentHash) {
      // Echo of our own write — expected, drop it.
      return;
    }

    this.log.warn(
      `Mirror ${asMirror.mirrorProviderEventId} edited directly; reverting from origin.`,
    );
    // Re-fetch origin and re-apply so the mirror is restored to source truth.
    const originCalendar = await this.prisma.calendar.findUniqueOrThrow({
      where: { id: asMirror.originCalendarId },
      include: { connectedAccount: true },
    });
    const origin = await this.provider.getEvent(
      {
        grantId: originCalendar.connectedAccount.aggregatorGrantId,
        providerCalendarId: originCalendar.providerCalendarId,
      },
      asMirror.originProviderEventId,
    );
    await this.applyToTarget(link, originCalendar.id, origin);
  }
}
