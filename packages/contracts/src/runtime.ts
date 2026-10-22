import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formats from 'ajv-formats';
import contract from './runtime-contract.json' with { type: 'json' };

type Schema = Record<string, any>;
type Parameter = { name: string; in: 'path' | 'query' | 'header'; required?: boolean; schema?: Schema };
type Operation = { operationId: string; method: string; path: string; parameters: Parameter[]; requestBody: Schema | null; requestContent: Record<string, { schema?: Schema }>; requestBodyRequired: boolean; security: unknown[] };
type Input = { path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown; contentType?: string };
type FieldError = { field: string; message: string };

const document = contract as { operations: Operation[]; schemas: Record<string, Schema>; chartSchema: Schema };
const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true, validateFormats: true });
(formats as unknown as { default: (instance: typeof ajv) => void }).default(ajv);
// Register local component pointers exactly as they appear in the canonical OpenAPI document.
ajv.addSchema({ $id: 'https://options-trade-ideas.invalid/openapi.json', components: { schemas: document.schemas } });
ajv.addSchema({ ...document.chartSchema, $id: 'https://options-trade-ideas.invalid/chart-state.schema.json' });
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function withAbsoluteRefs(schema: Schema): Schema {
  const copy = structuredClone(schema);
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string' && record.$ref.startsWith('#/')) record.$ref = `https://options-trade-ideas.invalid/openapi.json${record.$ref}`;
    else if (record.$ref === './chart-state.schema.json') record.$ref = 'https://options-trade-ideas.invalid/chart-state.schema.json';
    for (const child of Object.values(record)) visit(child);
  };
  visit(copy);
  return copy;
}

export class ContractValidationError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_REQUEST';
  constructor(readonly fieldErrors: readonly FieldError[]) {
    super('Request did not match the API contract');
    this.name = 'ContractValidationError';
  }
}

function validate(schema: Schema, value: unknown, field: string, errors: FieldError[]) {
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile(withAbsoluteRefs(schema));
    validators.set(schema, validator);
  }
  if (!validator(value)) {
    for (const issue of validator.errors ?? []) errors.push({ field: `${field}${issue.instancePath || ''}`, message: issue.message ?? 'invalid value' });
  }
}

/** Full chart-state JSON Schema 2020-12 validation, including its local $defs refs. */
export function validateChartState(value: unknown): boolean {
  const validator = ajv.compile(document.chartSchema);
  return validator(value) as boolean;
}

function routeParams(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((value): value is string => value !== undefined);
}

/** @internal Parameter coercion is separately exercised against hostile numeric text. */
export function coerce(value: unknown, schema: Schema | undefined): unknown {
  if (typeof value !== 'string' || !schema) return value;
  if (schema.type === 'integer' && /^-?\d+$/.test(value)) return Number(value);
  if (schema.type === 'number' && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return Number(value);
  if (schema.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

/** Validates path, query, declared headers and JSON body against one OpenAPI operation. */
export function validateRequest(operationId: string, input: Input): Input {
  const operation = document.operations.find((candidate) => candidate.operationId === operationId);
  if (!operation) throw new Error(`Unknown API operation: ${operationId}`);
  const errors: FieldError[] = [];
  const params = operation.parameters ?? [];
  const pathNames = routeParams(operation.path);
  const path = input.path ?? {};
  const query = input.query ?? {};
  const headers = input.headers ?? {};
  for (const key of Object.keys(input as object)) if (!['path', 'query', 'headers', 'body', 'contentType'].includes(key)) errors.push({ field: key, message: 'is not allowed' });
  for (const name of pathNames) if (!(name in path)) errors.push({ field: `path.${name}`, message: 'is required' });
  for (const name of Object.keys(path)) if (!pathNames.includes(name)) errors.push({ field: `path.${name}`, message: 'is not allowed' });
  const queryNames = params.filter((p) => p.in === 'query').map((p) => p.name);
  for (const name of Object.keys(query)) if (!queryNames.includes(name)) errors.push({ field: `query.${name}`, message: 'is not allowed' });
  const declaredHeaders = params.filter((p) => p.in === 'header');
  const headerNames = declaredHeaders.map((p) => p.name.toLowerCase());
  const suppliedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase());
  for (const name of suppliedHeaderNames) if (!headerNames.includes(name) && !['accept', 'content-type'].includes(name)) errors.push({ field: `headers.${name}`, message: 'is not allowed' });
  for (const parameter of params) {
    const source = parameter.in === 'path' ? path : parameter.in === 'query' ? query : headers;
    const key = parameter.in === 'header' ? Object.keys(headers).find((h) => h.toLowerCase() === parameter.name.toLowerCase()) : parameter.name;
    const value = key === undefined ? undefined : source[key];
    if (value === undefined) {
      if (parameter.required) errors.push({ field: `${parameter.in}.${parameter.name}`, message: 'is required' });
    } else validate(parameter.schema ?? {}, coerce(value, parameter.schema), `${parameter.in}.${parameter.name}`, errors);
  }
  if (operation.requestBodyRequired && input.body === undefined) errors.push({ field: 'body', message: 'is required' });
  if (Object.keys(operation.requestContent).length === 0 && input.body !== undefined) errors.push({ field: 'body', message: 'is not allowed' });
  if (input.body !== undefined && Object.keys(operation.requestContent).length) {
    const contentTypes = Object.keys(operation.requestContent);
    const contentType = input.contentType ?? (operation.requestContent['application/json'] ? 'application/json' : contentTypes.length === 1 ? contentTypes[0] : undefined);
    const media = contentType && operation.requestContent[contentType];
    if (!media) errors.push({ field: 'contentType', message: 'is not supported for this operation' });
    else if (media.schema?.format === 'binary') {
      if (!(input.body instanceof Blob || input.body instanceof ArrayBuffer || input.body instanceof Uint8Array)) errors.push({ field: 'body', message: 'must contain raw binary data' });
      else {
        const size = input.body instanceof Blob ? input.body.size : input.body.byteLength;
        if (size > 2_097_152) errors.push({ field: 'body', message: 'must not exceed 2097152 bytes' });
      }
    } else if (media.schema) validate(media.schema, input.body, 'body', errors);
  }
  if (errors.length) throw new ContractValidationError(errors);
  return input;
}
