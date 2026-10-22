import { operations, type OperationId, type OperationRequest, type OperationSuccess } from './generated.js';
import { validateRequest } from './runtime.js';

export type ApiRequest = { path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown; contentType?: string };
export type ApiResponse<T = unknown> = { readonly status: number; readonly headers: Headers; readonly data: T };
export type ApiClientOptions = { baseUrl?: string; fetch?: typeof fetch; csrfToken?: () => string | undefined };
export type ApiClient = { request<K extends OperationId>(operationId: K, ...args: {} extends OperationRequest<K> ? [request?: OperationRequest<K> & Pick<ApiRequest, 'contentType'>] : [request: OperationRequest<K> & Pick<ApiRequest, 'contentType'>]): Promise<ApiResponse<OperationSuccess<K>>> };
type RuntimeOperation = { operationId: OperationId; method: string; path: string; parameters: { in: string; name: string }[]; requestContent: Record<string, unknown>; security: unknown[] };

export class ApiProblemError extends Error {
  constructor(readonly status: number, readonly problem: unknown) {
    super('API request failed');
    this.name = 'ApiProblemError';
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '/api/v1';
  return {
    async request<K extends OperationId>(operationId: K, ...args: {} extends OperationRequest<K> ? [request?: OperationRequest<K> & Pick<ApiRequest, 'contentType'>] : [request: OperationRequest<K> & Pick<ApiRequest, 'contentType'>]): Promise<ApiResponse<OperationSuccess<K>>> {
      let request = (args[0] ?? {}) as ApiRequest;
      const operation = operations.find((candidate) => candidate.operationId === operationId) as RuntimeOperation | undefined;
      if (!operation) throw new Error(`Unknown API operation: ${operationId}`);
      const suppliedHeaders = { ...request.headers };
      const writes = operation.method !== 'GET';
      if (writes && operation.parameters.some((parameter) => parameter.in === 'header' && parameter.name.toLowerCase() === 'x-csrf-token') && !Object.keys(suppliedHeaders).some((name) => name.toLowerCase() === 'x-csrf-token')) {
        const token = options.csrfToken?.();
        if (token) suppliedHeaders['X-CSRF-Token'] = token;
      }
      request = { ...request, headers: suppliedHeaders };
      validateRequest(operationId, request);
      let path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(String(request.path?.[name])));
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
        else if (value !== undefined && value !== null) query.set(key, String(value));
      }
      if (query.size) path += `?${query.toString()}`;
      const headers = new Headers(request.headers);
      const requestTypes = Object.keys(operation.requestContent);
      const requestMediaType = request.contentType ?? (operation.requestContent['application/json'] ? 'application/json' : requestTypes.length === 1 ? requestTypes[0] : undefined);
      if (request.body !== undefined && requestMediaType) headers.set('Content-Type', requestMediaType);
      let body: BodyInit | undefined;
      if (request.body instanceof Blob || request.body instanceof ArrayBuffer || request.body instanceof Uint8Array) body = request.body as BodyInit;
      else if (requestMediaType === 'application/x-www-form-urlencoded' && request.body && typeof request.body === 'object') body = new URLSearchParams(request.body as Record<string, string>);
      else if (request.body !== undefined) body = JSON.stringify(request.body);
      const response = await fetcher(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: operation.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: operation.security.length === 0 ? 'omit' : 'same-origin',
        cache: 'no-store',
      });
      const responseMediaType = response.headers.get('content-type') ?? '';
      const data = responseMediaType.includes('json') ? await response.json()
        : responseMediaType === 'application/zip' || responseMediaType.startsWith('image/') ? await response.blob()
          : await response.text();
      if (!response.ok) throw new ApiProblemError(response.status, data);
      return { status: response.status, headers: response.headers, data: data as OperationSuccess<K> };
    },
  };
}
