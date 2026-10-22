import { ContractValidationError } from '@trading/contracts';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly requestId: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

export class CommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeDetail?: string,
    readonly errors?: readonly { readonly path: string; readonly message: string }[],
    readonly retryAfterSeconds?: number,
  ) {
    super(safeDetail ?? code);
    this.name = 'CommandError';
  }
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 422: 'Unprocessable Content', 429: 'Too Many Requests',
  503: 'Service Unavailable', 500: 'Internal Server Error',
};

/** Maps only explicit application errors to client-visible details; unknown errors are redacted. */
export function problemFromError(error: unknown, requestId: string): ProblemDetails {
  if (error instanceof ContractValidationError) {
    return {
      type: 'about:blank', title: 'Bad Request', status: 400, code: 'INVALID_REQUEST', requestId: requestId.slice(0, 100),
      errors: error.fieldErrors.slice(0, 100).map(({ field, message }) => ({ path: field.slice(0, 200), message: message.slice(0, 500) })),
    };
  }
  const known = error instanceof CommandError && error.status >= 400 && error.status <= 599
    && error.code.length > 0 && error.code.length <= 80;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const safeDetail = known && error.safeDetail ? error.safeDetail : undefined;
  return {
    type: `https://api.options-trade-ideas.invalid/problems/${encodeURIComponent(code.toLowerCase())}`,
    title: TITLES[status] ?? 'Request Failed',
    status,
    code,
    ...(safeDetail ? { detail: safeDetail.slice(0, 1000) } : {}),
    requestId: requestId.slice(0, 100),
    ...(known && error.errors ? { errors: error.errors.slice(0, 100).map(({ path, message }) => ({ path: path.slice(0, 200), message: message.slice(0, 500) })) } : {}),
  };
}
