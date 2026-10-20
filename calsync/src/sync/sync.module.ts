import { Module } from '@nestjs/common';
import { SyncEngineService } from './sync-engine.service';
import { IngestProcessor, SyncProcessor } from './sync.processor';

/**
 * The engine service is shared by web (none yet) and worker. The processors
 * only run in the worker process (see worker.ts), but registering them here is
 * harmless in web because no worker connection consumes unless started.
 */
@Module({
  providers: [SyncEngineService, IngestProcessor, SyncProcessor],
  exports: [SyncEngineService],
})
export class SyncModule {}
