import { Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { AUTH, AuthService, type AuthRequest } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { requestWithPathParams, validateIncomingRequest } from '../http/validate-request.js';
import { DraftService, parseIfMatch } from './service.js';

export const DRAFT_SERVICE = Symbol('DRAFT_SERVICE');
interface ResponseLike { setHeader(name: string, value: string): void; status(code: number): ResponseLike; end(): void }

@Controller()
export class DraftController {
  constructor(@Inject(AUTH) private readonly auth: AuthService, @Inject(DRAFT_SERVICE) private readonly drafts: DraftService) {}

  @Post('drafts')
  async create(@Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('createDraft', req);
    const created = await this.drafts.create(actor.userId, String(req.headers['idempotency-key']), valid.body as { kind: string; asset?: string });
    res.status(201); res.setHeader('ETag', `"${created.revision}"`);
    return created;
  }

  @Get('drafts')
  async list(@Req() req: AuthRequest) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    const valid = validateIncomingRequest('listDrafts', req);
    return this.drafts.list(actor.userId, valid.query?.cursor, valid.query?.limit);
  }

  @Get('drafts/:id')
  async get(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    validateIncomingRequest('getDraft', requestWithPathParams(req, { id }));
    const draft = await this.drafts.get(actor.userId, id);
    res.setHeader('ETag', `"${draft.revision}"`);
    return draft;
  }

  @Patch('drafts/:id')
  async patch(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('saveDraft', requestWithPathParams(req, { id }));
    const expected = parseIfMatch(req.headers['if-match']);
    const draft = await this.drafts.patch(actor.userId, id, expected, valid.body as Record<string, any>);
    res.setHeader('ETag', `"${draft.revision}"`);
    return draft;
  }

  @Delete('drafts/:id')
  async delete(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    await this.auth.assertCsrf(req, actor);
    validateIncomingRequest('deleteDraft', requestWithPathParams(req, { id }));
    const expected = parseIfMatch(req.headers['if-match']);
    await this.drafts.delete(actor.userId, id, expected);
    res.status(204).end();
  }

  @Get('drafts/:id/chart')
  async getChart(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    validateIncomingRequest('getDraftChart', requestWithPathParams(req, { id }));
    const chart = await this.drafts.getChart(actor.userId, id);
    res.setHeader('ETag', `"${chart.revision}"`);
    return chart;
  }

  @Put('drafts/:id/chart')
  async saveChart(@Param('id') id: string, @Req() req: AuthRequest, @Res({ passthrough: true }) res: ResponseLike) {
    const actor = await this.auth.authenticate(req, { verified: true, onboarded: true });
    await this.auth.assertCsrf(req, actor);
    const valid = validateIncomingRequest('saveDraftChart', requestWithPathParams(req, { id }));
    const expected = parseIfMatch(req.headers['if-match']);
    const state = valid.body as Record<string, any>;
    if (Object.keys(state).some(key => ['journalNotes', 'privateNotes', 'journal', 'authentication', 'sessionToken'].includes(key))) throw new CommandError(400, 'PRIVATE_FIELD_NOT_ALLOWED', 'Private journal or authentication fields cannot be stored in chart state.');
    const chart = await this.drafts.saveChart(actor.userId, id, expected, state as any);
    res.setHeader('ETag', `"${chart.revision}"`);
    return chart;
  }
}
