import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openapi = JSON.parse(await readFile(path.join(root, 'contracts/openapi.json'), 'utf8'));
const chartSchema = JSON.parse(await readFile(path.join(root, 'contracts/chart-state.schema.json'), 'utf8'));
const methods = ['get', 'post', 'put', 'patch', 'delete'];

function tsType(schema) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  const baseObject = schema.type === 'object' || schema.properties || schema.additionalProperties !== undefined
    ? (() => {
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${tsType(value)};`);
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') fields.push(`[key: string]: ${tsType(schema.additionalProperties)};`);
        else if (schema.additionalProperties === true) fields.push('[key: string]: unknown;');
        return `{ ${fields.join(' ')} }`;
      })()
    : undefined;
  const combinators = [];
  if (schema.allOf) combinators.push(...schema.allOf.map((s) => tsType(s)).filter((t) => t !== 'unknown'));
  if (schema.oneOf || schema.anyOf) {
    const branches = (schema.oneOf ?? schema.anyOf).map((s) => tsType(s)).filter((t) => t !== 'unknown');
    if (branches.length) combinators.push(`(${branches.join(' | ')})`);
  }
  if (schema.if || schema.then || schema.else) {
    // Conditional requirements are enforced by Ajv at runtime. Keep the declared base fields.
  }
  if (baseObject || combinators.length) return [baseObject, ...combinators].filter(Boolean).join(' & ') || 'unknown';
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map((t) => t === 'null' ? 'null' : tsType({ ...schema, type: t })).join(' | ');
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') return `ReadonlyArray<${tsType(schema.items)}>`;
  return 'unknown';
}

const schemas = openapi.components.schemas;
const chartDefs = chartSchema.$defs ?? {};
const componentNames = new Set(Object.keys(schemas));
function contractType(schema) {
  if (schema?.$ref === '../chart-state.schema.json') return 'ChartState';
  const ref = schema?.$ref;
  if (ref?.startsWith('#/$defs/')) return ref.split('/').at(-1);
  return tsType(schema);
}
const schemaTypes = Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${name === 'ChartState' ? tsType(chartSchema) : contractType(schema)};`).join('\n');
const localDefs = Object.entries(chartDefs).filter(([name]) => !componentNames.has(name)).map(([name, schema]) => `export type ${name} = ${tsType(schema)};`).join('\n');
const operations = [];
const pathTypes = [];
for (const [route, pathItem] of Object.entries(openapi.paths)) {
  const pathOperations = [];
  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation) continue;
    const requestContent = operation.requestBody?.content ?? {};
    const request = requestContent['application/json']?.schema ?? Object.values(requestContent)[0]?.schema;
    const responseContents = Object.fromEntries(Object.entries(operation.responses ?? {}).map(([status, response]) => [status, response.content ?? {}]));
    const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
    const record = { operationId: operation.operationId, method: method.toUpperCase(), path: route, parameters, requestBody: request ?? null, requestContent, requestBodyRequired: operation.requestBody?.required ?? false, responses: responseContents, security: operation.security ?? openapi.security ?? [] };
    operations.push(record);
    const parameterGroups = ['path', 'query', 'header'].map((location) => {
      const fields = parameters.filter((parameter) => parameter.in === location).map((parameter) => `${JSON.stringify(parameter.name)}${parameter.required ? '' : '?'}: ${contractType(parameter.schema)}`);
      return `${location}: { ${fields.join('; ')} }`;
    }).join('; ');
    const responseTypes = Object.entries(responseContents).map(([status, content]) => {
      const types = Object.entries(content).map(([media, item]) => item.schema?.format === 'binary' ? 'Blob' : media === 'text/csv' ? 'string' : contractType(item.schema));
      return `${JSON.stringify(status)}: ${types.length ? [...new Set(types)].join(' | ') : 'undefined'}`;
    }).join('; ');
    const requestTypes = Object.entries(requestContent).map(([media, item]) => `${JSON.stringify(media)}: ${item.schema?.format === 'binary' ? 'Blob | ArrayBuffer | Uint8Array' : contractType(item.schema)}`).join('; ');
    const requestUnion = Object.values(requestContent).map((item) => item.schema?.format === 'binary' ? 'Blob | ArrayBuffer | Uint8Array' : contractType(item.schema)).join(' | ') || 'never';
    pathOperations.push(`${method}: { operationId: ${JSON.stringify(operation.operationId)}; parameters: { ${parameterGroups} }; requestBody: ${requestUnion}; requestBodyRequired: ${operation.requestBody?.required ?? false}; requestContent: { ${requestTypes} }; responses: { ${responseTypes} } }`);
  }
  pathTypes.push(`${JSON.stringify(route)}: { ${pathOperations.join('; ')} }`);
}

const schemaMap = Object.keys(schemas).map((name) => `${JSON.stringify(name)}: ${name};`).join('\n');
const generated = `/* Generated by scripts/generate-contracts.mjs. Do not edit. */\n${schemaTypes}\n${localDefs}\nexport interface components { schemas: {\n${schemaMap}\n} }\nexport interface paths { ${pathTypes.join('; ')} }\nexport const operations = ${JSON.stringify(operations, null, 2)} as const;\nexport type OperationId = typeof operations[number]['operationId'];\nexport type OperationById<K extends OperationId> = Extract<{ [P in keyof paths]: { [M in keyof paths[P]]: paths[P][M] }[keyof paths[P]] }[keyof paths], { operationId: K }>;\nexport type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];\nexport type OptionalObject<T> = RequiredKeys<T> extends never ? { [K in keyof T]?: T[K] } : T;\nexport type ParameterGroup<P, K extends keyof P, Name extends string = K extends 'header' ? 'headers' : K extends string ? K : never> = RequiredKeys<P[K]> extends never ? { [Q in Name]?: P[K] } : { [Q in Name]: P[K] };\nexport type ParameterRequest<P> = ('path' extends keyof P ? ParameterGroup<P, 'path'> : {}) & ('query' extends keyof P ? ParameterGroup<P, 'query'> : {}) & ('header' extends keyof P ? ParameterGroup<P, 'header'> : {});\nexport type OperationRequest<K extends OperationId> = OperationById<K> extends infer O ? O extends { parameters: infer P; requestBody: infer B; requestBodyRequired: infer Q } ? ParameterRequest<P> & ([B] extends [never] ? {} : Q extends true ? { body: B } : { body?: B }) : never : never;\nexport type OperationSuccess<K extends OperationId> = OperationById<K> extends { responses: infer R } ? { [S in keyof R]: S extends \`2\${string}\` ? R[S] : never }[keyof R] : never;\n`;
const runtime = `${JSON.stringify({ operations, schemas, securitySchemes: openapi.components.securitySchemes, chartSchema }, null, 2)}\n`;
const outputs = [
  [path.join(root, 'packages/contracts/src/generated.ts'), generated],
  [path.join(root, 'packages/contracts/src/runtime-contract.json'), runtime],
];
if (process.argv.includes('--check')) {
  for (const [file, content] of outputs) {
    let current;
    try { current = await readFile(file, 'utf8'); } catch { current = ''; }
    if (current !== content) throw new Error(`${path.relative(root, file)} is stale; run pnpm --filter @trading/contracts generate`);
  }
  console.log(`Generated contracts are current (${operations.length} operations, ${Object.keys(schemas).length} schemas).`);
} else {
  for (const [file, content] of outputs) await writeFile(file, content);
  console.log(`Generated ${operations.length} operations and ${Object.keys(schemas).length} schema types.`);
}
console.log(`Generated ${operations.length} operations and ${Object.keys(schemas).length} schema types.`);
