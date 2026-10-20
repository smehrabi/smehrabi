import { PrivacyLevel } from '@prisma/client';
import {
  CanonicalEvent,
  MANAGED_METADATA_KEY,
} from '../providers/canonical-event';

export interface MirrorTag {
  syncLinkId: string;
  originAccount: string;
  eventLinkId?: string;
}

/**
 * Transform an origin event into the payload to write onto a mirror, according
 * to the link's privacy level.
 *
 * INVARIANTS (enforced here, asserted in tests):
 *   - Attendees/guests are NEVER present on a CanonicalEvent anyway, and this
 *     function never adds them. A mirror must never re-invite anyone.
 *   - All-day flag, timezone, and recurrence are preserved in every mode.
 *   - The managed metadata tag is always stamped so the mirror is identifiable
 *     as ours (loop prevention backstop).
 */
export function transformForPrivacy(
  origin: CanonicalEvent,
  level: PrivacyLevel,
  tag: MirrorTag,
): CanonicalEvent {
  const base: CanonicalEvent = {
    providerEventId: '', // assigned by the provider on create
    when: origin.when, // preserves allDay + timezone in all modes
    recurrence: origin.recurrence, // preserved in all modes
    busy: true, // a mirror always shows as Busy
    title: '',
    metadata: buildMetadata(tag),
  };

  switch (level) {
    case PrivacyLevel.full:
      return {
        ...base,
        title: origin.title,
        description: origin.description,
        location: origin.location,
      };
    case PrivacyLevel.title_only:
      return {
        ...base,
        title: origin.title,
        // no description, no location
      };
    case PrivacyLevel.busy_only:
      return {
        ...base,
        title: 'Busy',
        // no description, no location, no real title
      };
    default: {
      // Exhaustiveness guard: adding a PrivacyLevel without handling it fails to compile.
      const _never: never = level;
      throw new Error(`Unhandled privacy level: ${_never}`);
    }
  }
}

function buildMetadata(tag: MirrorTag): Record<string, string> {
  return {
    [MANAGED_METADATA_KEY]: '1',
    cs_sync_link_id: tag.syncLinkId,
    cs_origin_account: tag.originAccount,
    ...(tag.eventLinkId ? { cs_event_link_id: tag.eventLinkId } : {}),
  };
}

/** True if the event is one WE created (a mirror), via its metadata tag. */
export function isManagedMirror(event: CanonicalEvent): boolean {
  return event.metadata?.[MANAGED_METADATA_KEY] === '1';
}
