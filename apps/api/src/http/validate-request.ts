import { operations, validateRequest, type OperationId } from '@trading/contracts';

/** Transport headers such as Cookie/Origin are handled by session/CSRF policy,
 * not mistaken for undeclared JSON fields by contract validation. */
export function validateIncomingRequest(operationId: OperationId, request: {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}) {
  const operation = operations.find(item => item.operationId === operationId);
  if (!operation) throw new Error('Unknown server operation');
  const headers: Record<string, string> = {};
  const mediaType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  for (const parameter of operation.parameters) {
    if (parameter.in !== 'header') continue;
    const entry = Object.entries(request.headers).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase());
    if (entry && typeof entry[1] === 'string') headers[parameter.name] = entry[1];
  }
  return validateRequest(operationId, {
    path: request.params ?? {}, query: request.query ?? {}, headers,
    ...(typeof mediaType === 'string' ? { contentType: mediaType.split(';')[0]!.trim().toLowerCase() } : {}),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
}

/** Build a validator input without spreading Express' prototype-backed request. */
export function requestWithPathParams(request: {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
}, params: Record<string, unknown>) {
  return {
    headers: request.headers,
    params,
    ...(request.query === undefined ? {} : { query: request.query }),
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}
