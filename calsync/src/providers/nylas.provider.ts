import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import Nylas from 'nylas';
import {
  CalendarProvider,
  CalendarRef,
  ChangePage,
  ProviderCalendar,
} from './calendar-provider.port';
import {
  CanonicalEvent,
  MANAGED_METADATA_KEY,
  NormalizedChange,
} from './canonical-event';

/**
 * Nylas v3 driver. Translates between Nylas's Event object and CanonicalEvent,
 * stamps the managed-metadata tag on mirrors, verifies webhook HMAC signatures,
 * and normalizes timezone/all-day quirks.
 *
 * Field shapes below follow Nylas v3; verify against the current API reference
 * when wiring a live grant (https://developer.nylas.com/docs/api/v3/ecc/).
 */
@Injectable()
export class NylasProvider implements CalendarProvider {
  readonly name = 'nylas';
  private readonly log = new Logger(NylasProvider.name);
  private readonly nylas: Nylas;
  private readonly webhookSecret: string;

  constructor() {
    this.nylas = new Nylas({
      apiKey: process.env.NYLAS_API_KEY ?? '',
      apiUri: process.env.NYLAS_API_URI ?? 'https://api.us.nylas.com',
    });
    this.webhookSecret = process.env.NYLAS_WEBHOOK_SECRET ?? '';
  }

  async listCalendars(grantId: string): Promise<ProviderCalendar[]> {
    const res = await this.nylas.calendars.list({ identifier: grantId });
    return res.data.map((c: any) => ({
      providerCalendarId: c.id,
      name: c.name,
      timezone: c.timezone,
      isPrimary: Boolean(c.isPrimary),
      readOnly: Boolean(c.readOnly),
    }));
  }

  async getEvent(
    ref: CalendarRef,
    providerEventId: string,
  ): Promise<CanonicalEvent> {
    const res = await this.nylas.events.find({
      identifier: ref.grantId,
      eventId: providerEventId,
      queryParams: { calendarId: ref.providerCalendarId },
    });
    return this.toCanonical(res.data);
  }

  async listEventsChangedSince(
    ref: CalendarRef,
    _cursor: string | undefined,
    window: { startIso: string; endIso: string },
  ): Promise<ChangePage> {
    // Windowed list for backfill/reconciliation. Nylas paginates via
    // pageToken; the caller loops until nextCursor is empty.
    const res = await this.nylas.events.list({
      identifier: ref.grantId,
      queryParams: {
        calendarId: ref.providerCalendarId,
        start: Math.floor(new Date(window.startIso).getTime() / 1000).toString(),
        end: Math.floor(new Date(window.endIso).getTime() / 1000).toString(),
        pageToken: _cursor,
      },
    });
    return {
      events: res.data.map((e: any) => this.toCanonical(e)),
      nextCursor: res.nextCursor,
    };
  }

  async createEvent(ref: CalendarRef, event: CanonicalEvent): Promise<string> {
    const res = await this.nylas.events.create({
      identifier: ref.grantId,
      queryParams: { calendarId: ref.providerCalendarId },
      requestBody: this.toNylasBody(event),
    });
    return res.data.id;
  }

  async updateEvent(
    ref: CalendarRef,
    providerEventId: string,
    event: CanonicalEvent,
  ): Promise<void> {
    await this.nylas.events.update({
      identifier: ref.grantId,
      eventId: providerEventId,
      queryParams: { calendarId: ref.providerCalendarId },
      requestBody: this.toNylasBody(event),
    });
  }

  async deleteEvent(ref: CalendarRef, providerEventId: string): Promise<void> {
    try {
      await this.nylas.events.destroy({
        identifier: ref.grantId,
        eventId: providerEventId,
        queryParams: { calendarId: ref.providerCalendarId },
      });
    } catch (err: any) {
      // Idempotent delete: already gone is success.
      if (err?.statusCode === 404) return;
      throw err;
    }
  }

  /**
   * Verify the X-Nylas-Signature HMAC and normalize the notification into
   * change records. Signature failure yields an empty list (the controller
   * will have already persisted the raw body for audit).
   */
  parseWebhook(rawBody: string, signature: string): NormalizedChange[] {
    if (!this.verifySignature(rawBody, signature)) {
      this.log.warn('Rejected webhook with invalid signature');
      return [];
    }
    const body = JSON.parse(rawBody);
    const deltas: any[] = body.data ? [body.data] : body.deltas ?? [];
    const changes: NormalizedChange[] = [];
    for (const d of deltas) {
      const obj = d.object ?? d;
      const type = this.mapTriggerType(body.type ?? d.type);
      if (!type) continue;
      changes.push({
        providerCalendarId: obj.calendarId ?? obj.calendar_id,
        providerEventId: obj.id,
        type,
        seq: obj.updatedAt?.toString() ?? obj.updated_at?.toString(),
      });
    }
    return changes;
  }

  async renewSubscription(_ref: CalendarRef): Promise<void> {
    // Nylas manages notification channels at the application level; grant-level
    // renewal is a no-op here. Kept on the port for providers (e.g. Google
    // direct, Cronofy) that require periodic channel renewal.
  }

  verifySignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private mapTriggerType(t: string): NormalizedChange['type'] | null {
    switch (t) {
      case 'event.created':
        return 'created';
      case 'event.updated':
        return 'updated';
      case 'event.deleted':
        return 'deleted';
      default:
        return null;
    }
  }

  // ---- Canonical <-> Nylas mapping -------------------------------------

  private toCanonical(e: any): CanonicalEvent {
    return {
      providerEventId: e.id,
      masterId: e.masterEventId,
      recurrenceId: e.originalStartTime ? String(e.originalStartTime) : undefined,
      title: e.title ?? '',
      description: e.description,
      location: e.location,
      when: this.whenToCanonical(e.when),
      recurrence: e.recurrence ? { rrule: e.recurrence } : undefined,
      busy: e.busy !== false, // Nylas: busy defaults true
      seq: e.updatedAt?.toString(),
      metadata: e.metadata,
    };
  }

  private whenToCanonical(when: any): CanonicalEvent['when'] {
    // Nylas 'when' is a tagged union by object: 'date' (all-day single),
    // 'datespan' (all-day range), 'time', 'timespan'.
    if (when.object === 'date' || when.object === 'datespan') {
      return {
        allDay: true,
        start: when.date ?? when.startDate,
        end: when.date ?? when.endDate,
      };
    }
    // timed
    return {
      allDay: false,
      start: new Date((when.startTime ?? when.time) * 1000).toISOString(),
      end: new Date((when.endTime ?? when.time) * 1000).toISOString(),
      timezone: when.startTimezone ?? when.timezone,
    };
  }

  private toNylasBody(event: CanonicalEvent): any {
    const body: any = {
      title: event.title,
      busy: event.busy,
      metadata: event.metadata,
      when: this.whenToNylas(event.when),
    };
    if (event.description !== undefined) body.description = event.description;
    if (event.location !== undefined) body.location = event.location;
    if (event.recurrence) body.recurrence = event.recurrence.rrule;
    // IMPORTANT: participants are intentionally omitted — mirrors never carry
    // the guest list, so no duplicate invitations are ever sent.
    return body;
  }

  private whenToNylas(when: CanonicalEvent['when']): any {
    if (when.allDay) {
      // All-day stays a DATE; never apply a timezone offset.
      return when.start === when.end
        ? { object: 'date', date: when.start }
        : { object: 'datespan', startDate: when.start, endDate: when.end };
    }
    return {
      object: 'timespan',
      startTime: Math.floor(new Date(when.start).getTime() / 1000),
      endTime: Math.floor(new Date(when.end).getTime() / 1000),
      startTimezone: when.timezone,
      endTimezone: when.timezone,
    };
  }
}

/** Convenience re-export for tests/engine that need the tag key. */
export { MANAGED_METADATA_KEY };
