import { PrivacyLevel } from '@prisma/client';
import { CanonicalEvent } from '../src/providers/canonical-event';
import { contentHash } from '../src/sync/content-hash';
import { transformForPrivacy } from '../src/sync/privacy';

const tag = { syncLinkId: 'link_1', originAccount: 'cal_src' };

function origin(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    providerEventId: 'evt_origin',
    title: 'Standup',
    when: {
      allDay: false,
      start: '2026-10-20T15:00:00.000Z',
      end: '2026-10-20T15:15:00.000Z',
      timezone: 'UTC',
    },
    busy: true,
    ...overrides,
  };
}

describe('contentHash (loop-prevention guard #3)', () => {
  it('is stable across ids/metadata (self-echo suppression)', () => {
    // Our write, then the same content bounced back with a provider id + seq.
    const written = transformForPrivacy(origin(), PrivacyLevel.full, tag);
    const echoed = transformForPrivacy(
      origin({ providerEventId: 'mirror_123', seq: '9999' }),
      PrivacyLevel.full,
      { ...tag, eventLinkId: 'el_7' },
    );
    expect(contentHash(written)).toBe(contentHash(echoed));
  });

  it('changes when meaningful content changes', () => {
    const a = transformForPrivacy(origin(), PrivacyLevel.full, tag);
    const b = transformForPrivacy(
      origin({ title: 'Standup (moved)' }),
      PrivacyLevel.full,
      tag,
    );
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('differs across privacy levels for the same origin', () => {
    const full = transformForPrivacy(origin(), PrivacyLevel.full, tag);
    const busy = transformForPrivacy(origin(), PrivacyLevel.busy_only, tag);
    expect(contentHash(full)).not.toBe(contentHash(busy));
  });
});
