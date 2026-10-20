import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

/** Web entry point: HTTP API + webhook ingress. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // rawBody is required to verify webhook HMAC signatures over the exact bytes.
    new FastifyAdapter(),
    { rawBody: true },
  );
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[calsync:web] listening on :${port}`);
}

void bootstrap();
