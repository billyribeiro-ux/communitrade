export const HEALTH_STATUSES = ["ok", "not_ready"] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Matches the OpenAPI `Health` response (additionalProperties: false). */
export interface HealthResponse {
  readonly status: HealthStatus;
  readonly version: string;
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && (HEALTH_STATUSES as readonly unknown[]).includes(record.status)
    && typeof record.version === "string"
    && record.version.length <= 100;
}

export type { components, paths, OperationId, OperationRequest, OperationSuccess } from './generated.js';
export { operations } from './generated.js';
export { ContractValidationError, validateChartState, validateRequest } from './runtime.js';
export type { ApiClient, ApiClientOptions, ApiRequest, ApiResponse } from './client.js';
export { createApiClient } from './client.js';
