import {
  Controller,
  Get,
  Headers,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Nylas webhook verification handshake: echo back the challenge query param.
   */
  @Get('nylas')
  verify(@Query('challenge') challenge: string): string {
    return challenge ?? '';
  }

  /**
   * Inbound notification. We do the ABSOLUTE MINIMUM here — verify, persist,
   * enqueue — and return 200 fast. Providers disable endpoints that are slow
   * or error, so no sync work ever happens inline.
   */
  @Post('nylas')
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-nylas-signature') signature: string,
  ): Promise<{ ok: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.webhooks.ingest(raw, signature ?? '');
    return { ok: true };
  }
}
