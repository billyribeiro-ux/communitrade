import { randomUUID } from 'node:crypto';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { CommandError, problemFromError } from './problem.js';

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
  type(value: string): HttpResponse;
  json(value: unknown): void;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<HttpResponse>();
    const request = context.getRequest<{ url: string; method: string }>();
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    // Keep the deliberately minimal health 503 contract from P01.
    if (request.method === 'GET' && request.url.split('?')[0] === '/api/v1/health/ready'
      && exception instanceof HttpException && exception.getStatus() === 503) {
      response.status(503).type('application/json').json({ status: 'not_ready', version: '0.1.0' });
      return;
    }
    const parserError = exception as { type?: string; status?: number };
    const normalized = parserError?.type === 'entity.too.large' ? new CommandError(400,'BODY_TOO_LARGE','The request exceeds the allowed size.') : parserError?.type === 'entity.parse.failed' ? new CommandError(400,'INVALID_BODY','The request body could not be parsed.') : exception instanceof HttpException
      ? new CommandError(exception.getStatus(), exception.getStatus() === 404 ? 'NOT_FOUND' : 'HTTP_REQUEST_FAILED')
      : exception;
    const problem = problemFromError(normalized, requestId);
    if (problem.status === 500) {
      // Never log exception messages, request URLs/bodies, cookies or provider claims.
      const frames = exception instanceof Error ? exception.stack?.split('\n').slice(1).filter(line => /\/apps\/api\/(?:src|dist)\//.test(line)).slice(0, 3).map(line => line.trim()) : [];
      console.error(JSON.stringify({ event: 'api.unhandled', requestId, errorType: exception instanceof Error ? exception.name : 'Unknown', frames }));
    }
    if (problem.status === 429) {
      const requested = normalized instanceof CommandError ? normalized.retryAfterSeconds : undefined;
      response.setHeader('Retry-After', String(Number.isSafeInteger(requested) && requested! >= 1 && requested! <= 3600 ? requested : 60));
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}
