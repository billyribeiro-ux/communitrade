import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@trading/contracts';

export const DATABASE = Symbol('DATABASE');
export interface ReadinessDatabase {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
}

// Explicit injection works in both tsx development and direct TypeScript CLI builds.
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: ReadinessDatabase) {}

  @Get('live')
  live(): HealthResponse { return { status: 'ok', version: '0.1.0' }; }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      // A live connection without the expected migration is not ready.
      await this.database.$queryRaw`SELECT
        (SELECT id FROM foundation_probe LIMIT 1),
        (SELECT nonce FROM trusted_ingress_nonce LIMIT 1),
        (SELECT event_id FROM email_webhook_event LIMIT 1),
        (SELECT email_hash FROM email_address_suppression LIMIT 1)`;
      return { status: 'ok', version: '0.1.0' };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', version: '0.1.0' });
    }
  }
}
