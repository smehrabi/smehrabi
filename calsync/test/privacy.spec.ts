import { PrivacyLevel } from '@prisma/client';
import {
  CanonicalEvent,
  MANAGED_METADATA_KEY,
} from '../src/providers/canonical-event';
import {
  isManagedMirror,
  transformForPrivacy,
} from '../src/sync/privacy';

const tag = { syncLinkId: 'link_1', originAccount: 'cal_src', eventLinkId: 'el_1' };

function origin(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    providerEventId: 'evt_origin',
    title: 'Board meeting',
    description: 'Q3 numbers and strategy',
    location: 'Room 4A',
    when: {
      allDay: false,
      start: '2026-10-20T15:00:00.000Z',
      end: '2026-10-20T16:00:00.000Z',
      timezone: 'America/New_York',
    },
    busy: true,
    seq: '1000',
    ...overrides,
  };
}

describe('transformForPrivacy', () => {
  it('full mode copies title/location/description', () => {
    const m = transformForPrivacy(origin(), PrivacyLevel.full, tag);
    expect(m.title).toBe('Board meeting');
    expect(m.description).toBe('Q3 numbers and strategy');
    expect(m.location).toBe('Room 4A');
  });

  it('title_only mode copies only the title', () => {
    const m = transformForPrivacy(origin(), PrivacyLevel.title_only, tag);
    expect(m.title).toBe('Board meeting');
    expect(m.description).toBeUndefined();
    expect(m.location).toBeUndefined();
  });

  it('busy_only mode shows an opaque Busy block', () => {
    const m = transformForPrivacy(origin(), PrivacyLevel.busy_only, tag);
    expect(m.title).toBe('Busy');
    expect(m.description).toBeUndefined();
    expect(m.location).toBeUndefined();
  });

  it.each([PrivacyLevel.full, PrivacyLevel.title_only, PrivacyLevel.busy_only])(
    'NEVER copies attendees/participants in %s mode',
    (level) => {
      const m = transformForPrivacy(origin(), level, tag) as unknown as Record<
        string,
        unknown
      >;
      // The canonical shape has no attendee field by design; assert nothing
      // participant-like ever leaks onto a mirror payload.
      for (const key of Object.keys(m)) {
        expect(key.toLowerCase()).not.toContain('attendee');
        expect(key.toLowerCase()).not.toContain('participant');
        expect(key.toLowerCase()).not.toContain('guest');
      }
    },
  );

  it.each([PrivacyLevel.full, PrivacyLevel.title_only, PrivacyLevel.busy_only])(
    'preserves timezone and all-day flag in %s mode',
    (level) => {
      const timed = transformForPrivacy(origin(), level, tag);
      expect(timed.when.allDay).toBe(false);
      expect(timed.when.timezone).toBe('America/New_York');

      const allDay = transformForPrivacy(
        origin({ when: { allDay: true, start: '2026-10-20', end: '2026-10-20' } }),
        level,
        tag,
      );
      expect(allDay.when.allDay).toBe(true);
      expect(allDay.when.start).toBe('2026-10-20'); // no tz offset / day shift
    },
  );

  it('stamps the managed metadata tag so the mirror is identifiable', () => {
    const m = transformForPrivacy(origin(), PrivacyLevel.full, tag);
    expect(m.metadata?.[MANAGED_METADATA_KEY]).toBe('1');
    expect(m.metadata?.cs_sync_link_id).toBe('link_1');
    expect(isManagedMirror(m)).toBe(true);
  });

  it('a plain origin event is not detected as a managed mirror', () => {
    expect(isManagedMirror(origin())).toBe(false);
  });
});
