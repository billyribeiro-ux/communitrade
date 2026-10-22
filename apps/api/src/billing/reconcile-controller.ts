import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { CommandError } from '../http/problem.js';
import { validateIncomingRequest } from '../http/validate-request.js';
import type { AuthRequest } from '../auth/service.js';
import { BILLING_SERVICE } from './controller.js';
import { BillingService } from './service.js';

export function billingReconcileAuthorization(secret: string, seconds: number, nonce: string): string {
  return createHmac('sha256', secret).update(`billing-reconcile:v1:${seconds}:${nonce}`).digest('base64url');
}

/** Only the scheduler invokes this bounded provider-truth sweep; no caller-selected owner/state. */
@Controller()
export class BillingReconcileController {
  constructor(@Inject(BILLING_SERVICE) private readonly billing: BillingService) {}

  @Post('internal/billing/reconcile')
  async reconcile(@Req() req: AuthRequest, @Res() res: { status(code: number): { end(): void } }) {
    const secret = process.env.SESSION_SECRET ?? '';
    const header = req.headers['x-billing-authorization'];
    const match = typeof header === 'string' && /^(\d{10})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header);
    if (secret.length < 32 || !match || Math.abs(Math.floor(Date.now() / 1000) - Number(match[1])) > 30) {
      throw new CommandError(401, 'SERVICE_AUTH_REQUIRED');
    }
    const expected = billingReconcileAuthorization(secret, Number(match[1]), match[2]!);
    if (!timingSafeEqual(Buffer.from(match[3]!), Buffer.from(expected))) throw new CommandError(401, 'SERVICE_AUTH_REQUIRED');
    validateIncomingRequest('reconcileBillingProviderState', req);
    await this.billing.reconcilePendingOperations(5);
    res.status(204).end();
  }
}
