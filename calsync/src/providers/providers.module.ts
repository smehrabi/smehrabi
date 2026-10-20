import { Global, Module } from '@nestjs/common';
import { CALENDAR_PROVIDER } from './calendar-provider.port';
import { NylasProvider } from './nylas.provider';

/**
 * Binds the active CalendarProvider. Swap NylasProvider for a future
 * CronofyProvider here (or choose by env) without touching engine code.
 */
@Global()
@Module({
  providers: [
    NylasProvider,
    { provide: CALENDAR_PROVIDER, useExisting: NylasProvider },
  ],
  exports: [CALENDAR_PROVIDER, NylasProvider],
})
export class ProvidersModule {}
