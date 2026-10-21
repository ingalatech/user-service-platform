import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenAPI compatibility gate for the first external consumer (ADR-0007,
// ticket #152). This project-owned comparator is the retained tool for this
// increment, not universal OpenAPI analysis. Additive evolution within `/v1`
// — new operations, optional fields, new schemas — passes. Removing/renaming
// contract members, changing their type or meaning, or making optional input
// mandatory fails: those need an explicit versioned transition (normally
// `/v2`).
//
// Only contract keywords are compared (`type`, `format`, `required`,
// `properties`, `items`, `enum`, operations, parameters). Documentation text
// (`description`, `example`) never breaks compatibility. Other changed
// validation constraints/compositions conservatively require review.
export interface CompatFinding {
  readonly breaking: boolean;
  readonly message: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    return null;
  }
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const record = asRecord(current);
    if (record === null) {
      return null;
    }
    current = record[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current ?? null;
}

function dereference(root: unknown, schema: unknown): unknown {
  const record = asRecord(schema);
  if (record !== null && typeof record.$ref === 'string') {
    return resolveRef(root, record.$ref) ?? schema;
  }
  return schema;
}

function mediaSchema(root: unknown, operation: unknown, location: 'request' | 'response'): unknown {
  const record = asRecord(operation);
  if (record === null) {
    return null;
  }
  if (location === 'request') {
    const body = dereference(root, record.requestBody);
    const content = asRecord(asRecord(body)?.content)?.['application/json'];
    return dereference(root, asRecord(content)?.schema);
  }
  const responses = asRecord(record.responses);
  for (const status of ['200', '201', '202']) {
    const content = asRecord(asRecord(responses?.[status])?.content)?.['application/json'];
    const schema = dereference(root, asRecord(content)?.schema);
    if (schema !== null && schema !== undefined) {
      return schema;
    }
  }
  return null;
}

// Compares two schemas for breaking changes. `where` names the contract
// location for deterministic messages. Added `required` entries, removed
// properties and type/format changes break. Requests cannot require more
// input or narrow accepted enums; responses cannot stop guaranteeing required
// fields or expand output enums. Shared component changes are conservative;
// added operations, optional properties and new schemas pass.
function compareSchemas(
  baselineRoot: unknown,
  baseline: unknown,
  currentRoot: unknown,
  current: unknown,
  where: string,
  findings: CompatFinding[],
  direction: 'request' | 'response' | 'conservative' = 'conservative',
): void {
  const base = asRecord(dereference(baselineRoot, baseline));
  const next = asRecord(dereference(currentRoot, current));
  if (base === null || next === null) {
    if (base !== null && next === null)
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: schema was removed.`,
      });
    return;
  }
  const baseType = base.type;
  const nextType = next.type;
  if (baseType !== undefined && JSON.stringify(baseType) !== JSON.stringify(nextType)) {
    findings.push({
      breaking: true,
      message: `Breaking change at ${where}: type changed.`,
    });
    return;
  }
  const baseFormat = base.format;
  const nextFormat = next.format;
  if (typeof baseFormat === 'string' && baseFormat !== nextFormat) {
    findings.push({
      breaking: true,
      message: `Breaking change at ${where}: format changed.`,
    });
  }
  const baseRequired = Array.isArray(base.required)
    ? base.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const nextRequired = Array.isArray(next.required)
    ? next.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const entry of direction === 'response' ? baseRequired : nextRequired) {
    if (!(direction === 'response' ? nextRequired : baseRequired).includes(entry)) {
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: '${entry}' ${direction === 'response' ? 'is no longer guaranteed' : 'became required'}.`,
      });
    }
  }
  const baseProperties = asRecord(base.properties) ?? {};
  const nextProperties = asRecord(next.properties) ?? {};
  for (const name of Object.keys(baseProperties)) {
    if (!(name in nextProperties)) {
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: property '${name}' was removed.`,
      });
      continue;
    }
    compareSchemas(
      baselineRoot,
      baseProperties[name],
      currentRoot,
      nextProperties[name],
      `${where}.${name}`,
      findings,
      direction,
    );
  }
  if (base.items !== undefined || next.items !== undefined) {
    compareSchemas(
      baselineRoot,
      base.items,
      currentRoot,
      next.items,
      `${where}[]`,
      findings,
      direction,
    );
  }
  const baseEnum = Array.isArray(base.enum) ? base.enum : null;
  const nextEnum = Array.isArray(next.enum) ? next.enum : null;
  const contains = (values: unknown[], value: unknown): boolean =>
    values.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
  const narrowedInput =
    direction !== 'response' &&
    nextEnum !== null &&
    (baseEnum === null || baseEnum.some((value) => !contains(nextEnum, value)));
  const widenedOutput =
    direction !== 'request' &&
    baseEnum !== null &&
    (nextEnum === null || nextEnum.some((value) => !contains(baseEnum, value)));
  if (narrowedInput || widenedOutput)
    findings.push({
      breaking: true,
      message: `Breaking change at ${where}: enum contract changed.`,
    });
  // Unhandled validation constraints/compositions require review on change;
  // annotation-only edits do not affect the compatibility decision.
  const structural = new Set(['$ref', 'type', 'format', 'required', 'properties', 'items', 'enum']);
  const annotations = new Set([
    'description',
    'example',
    'examples',
    'title',
    'deprecated',
    'default',
    '$schema',
  ]);
  for (const keyword of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (structural.has(keyword) || annotations.has(keyword)) continue;
    if (JSON.stringify(base[keyword]) !== JSON.stringify(next[keyword]))
      findings.push({
        breaking: true,
        message: `Contract review required at ${where}: '${keyword}' changed.`,
      });
  }
}

function compareParameters(
  baselineRoot: unknown,
  baseline: unknown,
  currentRoot: unknown,
  current: unknown,
  where: string,
  findings: CompatFinding[],
): void {
  const baseParams = asRecord(baseline)?.parameters;
  const nextParams = asRecord(current)?.parameters;
  const toUnknownList = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) return [];
    const entries: unknown[] = value;
    return [...entries];
  };
  const baseList = toUnknownList(baseParams);
  const nextList = toUnknownList(nextParams);
  const keyOf = (root: unknown, param: unknown): string => {
    const record = asRecord(dereference(root, param)) ?? {};
    return `${String(record.in)}:${String(record.name)}`;
  };
  const nextKeys = new Set(nextList.map((p) => keyOf(currentRoot, p)));
  const baseKeys = new Set(baseList.map((p) => keyOf(baselineRoot, p)));
  for (const param of nextList) {
    const key = keyOf(currentRoot, param);
    if (!baseKeys.has(key) && asRecord(dereference(currentRoot, param))?.required === true)
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: new required parameter '${key}'.`,
      });
  }
  for (const param of baseList) {
    const key = keyOf(baselineRoot, param);
    if (!nextKeys.has(key)) {
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: parameter '${key}' was removed.`,
      });
      continue;
    }
    const nextParam = nextList.find((candidate) => keyOf(currentRoot, candidate) === key);
    const baseResolved = asRecord(dereference(baselineRoot, param)) ?? {};
    const nextResolved = asRecord(dereference(currentRoot, nextParam)) ?? {};
    // Making a parameter required breaks existing callers; making one
    // optional loosens the contract and stays compatible.
    if (nextResolved.required === true && baseResolved.required !== true) {
      findings.push({
        breaking: true,
        message: `Breaking change at ${where}: parameter '${key}' became required.`,
      });
    }
    compareSchemas(
      baselineRoot,
      baseResolved.schema,
      currentRoot,
      nextResolved.schema,
      `${where} parameter '${key}'`,
      findings,
      'request',
    );
  }
}

export function compareOpenApiDocuments(baseline: unknown, current: unknown): CompatFinding[] {
  const findings: CompatFinding[] = [];
  const basePaths = asRecord(asRecord(baseline)?.paths) ?? {};
  const nextPaths = asRecord(asRecord(current)?.paths) ?? {};
  for (const path of Object.keys(basePaths)) {
    const baseOperations = asRecord(basePaths[path]) ?? {};
    const nextOperations = asRecord(nextPaths[path]) ?? {};
    for (const method of HTTP_METHODS) {
      if (baseOperations[method] === undefined) {
        continue;
      }
      const where = `${method.toUpperCase()} ${path}`;
      if (nextOperations[method] === undefined) {
        findings.push({
          breaking: true,
          message: `Breaking change at ${where}: operation removed.`,
        });
        continue;
      }
      const oldOperation = asRecord(baseOperations[method]) ?? {};
      const newOperation = asRecord(nextOperations[method]) ?? {};
      if (oldOperation.operationId !== newOperation.operationId)
        findings.push({
          breaking: true,
          message: `Breaking change at ${where}: operationId changed.`,
        });
      if (
        asRecord(newOperation.requestBody)?.required === true &&
        asRecord(oldOperation.requestBody)?.required !== true
      )
        findings.push({
          breaking: true,
          message: `Breaking change at ${where}: request body became required.`,
        });
      const oldResponses = asRecord(oldOperation.responses) ?? {};
      const newResponses = asRecord(newOperation.responses) ?? {};
      for (const status of Object.keys(oldResponses)) {
        if (!(status in newResponses))
          findings.push({
            breaking: true,
            message: `Breaking change at ${where}: response ${status} removed.`,
          });
        const oldContent = asRecord(asRecord(oldResponses[status])?.content) ?? {};
        const newContent = asRecord(asRecord(newResponses[status])?.content) ?? {};
        for (const mime of Object.keys(oldContent)) {
          if (!(mime in newContent))
            findings.push({
              breaking: true,
              message: `Breaking change at ${where}: response ${status} ${mime} removed.`,
            });
          compareSchemas(
            baseline,
            asRecord(oldContent[mime])?.schema,
            current,
            asRecord(newContent[mime])?.schema,
            `${where} response ${status} ${mime}`,
            findings,
            'response',
          );
        }
      }
      compareSchemas(
        baseline,
        mediaSchema(baseline, baseOperations[method], 'request'),
        current,
        mediaSchema(current, nextOperations[method], 'request'),
        `${where} request`,
        findings,
        'request',
      );
      compareSchemas(
        baseline,
        mediaSchema(baseline, baseOperations[method], 'response'),
        current,
        mediaSchema(current, nextOperations[method], 'response'),
        `${where} response`,
        findings,
        'response',
      );
      compareParameters(
        baseline,
        baseOperations[method],
        current,
        nextOperations[method],
        where,
        findings,
      );
    }
  }
  const baseSchemas = asRecord(asRecord(asRecord(baseline)?.components)?.schemas) ?? {};
  const nextSchemas = asRecord(asRecord(asRecord(current)?.components)?.schemas) ?? {};
  for (const name of Object.keys(baseSchemas)) {
    if (nextSchemas[name] === undefined) {
      findings.push({
        breaking: true,
        message: `Breaking change at schema ${name}: schema removed.`,
      });
      continue;
    }
    compareSchemas(
      baseline,
      baseSchemas[name],
      current,
      nextSchemas[name],
      `schema ${name}`,
      findings,
    );
  }
  return findings;
}

const cliPath = process.argv[1];
if (cliPath !== undefined && resolve(cliPath) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const baselinePath = resolve(root, process.argv[2] ?? 'openapi/baseline/a88774e.json');
  const currentPath = resolve(root, process.argv[3] ?? 'openapi/openapi.json');

  const baselineDocument = JSON.parse(await readFile(baselinePath, 'utf8')) as unknown;
  const currentDocument = JSON.parse(await readFile(currentPath, 'utf8')) as unknown;
  const breaking = compareOpenApiDocuments(baselineDocument, currentDocument).filter(
    (finding) => finding.breaking,
  );
  if (breaking.length > 0) {
    for (const finding of breaking) {
      console.log(finding.message);
    }
    console.log(`OpenAPI compatibility failed: ${String(breaking.length)} breaking change(s).`);
    process.exitCode = 1;
  } else {
    console.log('OpenAPI compatibility passed: no breaking changes.');
  }
}
