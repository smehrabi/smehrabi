/**
 * CanonicalEvent is CalSync's internal, vendor-neutral event shape. Every
 * provider driver translates to/from this; the sync engine speaks ONLY this
 * type and never touches a vendor SDK directly. This is the seam that keeps us
 * from being locked to Nylas.
 */

/** Provider-side tag we stamp on every mirror we create (loop prevention). */
export const MANAGED_METADATA_KEY = 'cs_managed';

export interface EventTime {
  /**
   * All-day events carry a DATE ('2026-10-20'), never a datetime, and MUST NOT
   * have a timezone offset applied — that is the classic off-by-one-day bug.
   */
  allDay: boolean;
  /** RFC3339 datetime for timed events, or 'YYYY-MM-DD' for all-day. */
  start: string;
  end: string;
  /** IANA timezone (e.g. 'America/New_York'). Required for timed events. */
  timezone?: string;
}

export interface Recurrence {
  /** RRULE strings as the provider expresses them (e.g. 'RRULE:FREQ=WEEKLY'). */
  rrule: string[];
}

/** Metadata we attach to mirrors to identify them later, provider-side. */
export interface ManagedMetadata {
  [MANAGED_METADATA_KEY]: '1';
  cs_event_link_id?: string;
  cs_sync_link_id: string;
  cs_origin_account: string;
}

export interface CanonicalEvent {
  providerEventId: string;
  /** Recurrence master id, if this is part of a series. */
  masterId?: string;
  /** Specific overridden instance id; absent for a master or single event. */
  recurrenceId?: string;

  title: string;
  description?: string;
  location?: string;
  when: EventTime;
  recurrence?: Recurrence;

  /**
   * true = shows as Busy, false = Free/transparent. Drives the include-
   * transparent filter. We never propagate attendees, so this is the only
   * participation signal that matters.
   */
  busy: boolean;

  /** Provider version / updated-at; used to dedupe reprocessing. */
  seq?: string;

  /** Present (and cs_managed='1') only on events WE created. See ManagedMetadata. */
  metadata?: Record<string, string>;
}

/** A normalized change parsed out of a provider webhook. */
export interface NormalizedChange {
  providerCalendarId: string;
  providerEventId: string;
  type: 'created' | 'updated' | 'deleted';
  /** Provider version/sequence, if supplied. */
  seq?: string;
}
