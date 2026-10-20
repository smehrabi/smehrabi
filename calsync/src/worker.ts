import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/** Worker entry point: consumes queues and runs the sync engine. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  await app.init();
  // eslint-disable-next-line no-console
  console.log('[calsync:worker] consuming ingest + sync queues');
}

void bootstrap();
