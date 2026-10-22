import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { ExportService, type ExportCommand } from './service.js';

export const EXPORT_SERVICE = Symbol('EXPORT_SERVICE');
interface RequestWithQuery extends AuthRequest { query?: Record<string, unknown> }
interface ResponseLike { status(code: number): ResponseLike; setHeader(name: string, value: string): void; json(value: unknown): void; send(value: Buffer): void }

@Controller()
export class ExportController {
  constructor(@Inject(AUTH) private readonly auth: AuthService, @Inject(EXPORT_SERVICE) private readonly exports: ExportService) {}

  @Post('exports')
  async request(@Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('requestExport', req);
    const key = header(req.headers['idempotency-key']);
    if (!key) throw new CommandError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid idempotency key is required.');
    const result = await this.exports.request(actor.userId, key, valid.body as ExportCommand);
    res.status(202); return result;
  }

  @Get('exports')
  async list(@Req() req: RequestWithQuery) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    const valid = validateIncomingRequest('listExports', req);
    const cursor = single(valid.query?.cursor); const limit = valid.query?.limit;
    return this.exports.list(actor.userId, cursor, typeof limit === 'number' ? limit : typeof limit === 'string' ? Number(limit) : undefined);
  }

  @Get('exports/:id')
  async get(@Param('id') id: string, @Req() req: AuthRequest) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    validateIncomingRequest('getExport', requestWithPathParams(req, { id }));
    return this.exports.get(actor.userId, id);
  }

  @Get('exports/:id/download')
  async download(@Param('id') id: string, @Req() req: AuthRequest, @Res() res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    validateIncomingRequest('downloadExport', requestWithPathParams(req, { id }));
    const result = await this.exports.download(actor.userId, id);
    res.setHeader('Content-Type', result.kind === 'personal_archive' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(result.bytes);
  }
}

function header(value: string | string[] | undefined): string | undefined { return typeof value === 'string' ? value : undefined; }
function single(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
