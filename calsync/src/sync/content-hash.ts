import { createHash } from 'crypto';
import { CanonicalEvent } from '../providers/canonical-event';

/**
 * Stable hash of the MEANINGFUL fields of a transformed mirror payload.
 *
 * Used for idempotency and self-echo suppression: after we write a mirror we
 * store this hash on the EventLink. When our own write bounces back as a
 * webhook, recomputing the hash matches what we stored, so the change is a
 * no-op and the loop is broken before any provider call.
 *
 * Deliberately excludes volatile fields (providerEventId, seq, per-write
 * metadata) so equivalent content hashes equal regardless of ids.
 */
export function contentHash(event: CanonicalEvent): string {
  const canonical = {
    title: event.title,
    description: event.description ?? null,
    location: event.location ?? null,
    when: {
      allDay: event.when.allDay,
      start: event.when.start,
      end: event.when.end,
      timezone: event.when.timezone ?? null,
    },
    recurrence: event.recurrence?.rrule ?? null,
    busy: event.busy,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
