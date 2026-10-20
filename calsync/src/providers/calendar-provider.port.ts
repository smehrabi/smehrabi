import { CanonicalEvent, NormalizedChange } from './canonical-event';

/** Reference to a calendar within a provider account (grant + calendar id). */
export interface CalendarRef {
  grantId: string;
  providerCalendarId: string;
}

export interface ProviderCalendar {
  providerCalendarId: string;
  name: string;
  timezone?: string;
  isPrimary: boolean;
  readOnly: boolean;
}

export interface ChangePage {
  events: CanonicalEvent[];
  nextCursor?: string;
}

/**
 * The single port every calendar backend implements. Business logic depends on
 * this interface, never on a concrete SDK. Swapping Nylas for Cronofy is a new
 * driver, not a rewrite.
 */
export interface CalendarProvider {
  readonly name: string;

  listCalendars(grantId: string): Promise<ProviderCalendar[]>;

  getEvent(ref: CalendarRef, providerEventId: string): Promise<CanonicalEvent>;

  /** Paged change feed used by backfill and reconciliation. */
  listEventsChangedSince(
    ref: CalendarRef,
    cursor: string | undefined,
    window: { startIso: string; endIso: string },
  ): Promise<ChangePage>;

  /** Create a mirror. Implementations MUST stamp the managed metadata tag. */
  createEvent(ref: CalendarRef, event: CanonicalEvent): Promise<string>;

  updateEvent(
    ref: CalendarRef,
    providerEventId: string,
    event: CanonicalEvent,
  ): Promise<void>;

  /** Idempotent: a 404 (already gone) resolves successfully. */
  deleteEvent(ref: CalendarRef, providerEventId: string): Promise<void>;

  /** Verify signature and normalize an inbound webhook into change records. */
  parseWebhook(rawBody: string, signature: string): NormalizedChange[];

  /** Renew a push subscription before it expires. */
  renewSubscription(ref: CalendarRef): Promise<void>;
}

/** DI token for the active provider. */
export const CALENDAR_PROVIDER = Symbol('CALENDAR_PROVIDER');
