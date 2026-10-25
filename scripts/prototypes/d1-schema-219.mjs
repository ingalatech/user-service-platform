// PROTOTYPE: disposable local D1 schema-mutation probe for issue #219.
// Run with: npx tsx scripts/prototypes/d1-schema-219.mjs
// Every query runs inside workerd through Wrangler local mode's D1 binding.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'd1-schema-219-'));
const evidencePath = join(tmpdir(), `${basename(scratch)}-evidence.json`);
const workerPath = join(scratch, 'worker.mjs');
const configPath = join(scratch, 'wrangler.jsonc');
const databaseId = '21900000-0000-4000-8000-000000000001';

const worker = `
export default {
  async fetch(request, env) {
    const input = await request.json();
    try {
      if (input.action === 'statements') {
        const results = [];
        for (const item of input.statements) {
          const statement = env.DB.prepare(item.sql);
          const bound = item.values ? statement.bind(...item.values) : statement;
          results.push(item.mode === 'all' ? await bound.all() : await bound.run());
        }
        return Response.json({ results });
      }
      if (input.action === 'batch') {
        const statements = input.statements.map((item) => {
          const statement = env.DB.prepare(item.sql);
          return item.values ? statement.bind(...item.values) : statement;
        });
        return Response.json({ results: await env.DB.batch(statements) });
      }
      if (input.action === 'preparedAcrossDdl') {
        const before = env.DB.prepare('SELECT id, value FROM "records" WHERE id = ?');
        const beforeResult = await before.bind('r1').first();
        await env.DB.prepare('ALTER TABLE "records" RENAME COLUMN "value" TO "renamed_value"').run();
        let staleAfterRename;
        try {
          staleAfterRename = { result: await before.bind('r1').first() };
        } catch (error) {
          staleAfterRename = { error: String(error.message) };
        }
        await env.DB.prepare('ALTER TABLE "records" ADD COLUMN "temporary" TEXT').run();
        const beforeDrop = env.DB.prepare('SELECT temporary FROM "records" WHERE id = ?');
        await beforeDrop.bind('r1').first();
        await env.DB.prepare('ALTER TABLE "records" DROP COLUMN "temporary"').run();
        let staleAfterDrop;
        try {
          staleAfterDrop = { result: await beforeDrop.bind('r1').first() };
        } catch (error) {
          staleAfterDrop = { error: String(error.message) };
        }
        return Response.json({ beforeResult, staleAfterRename, staleAfterDrop });
      }
      if (input.action === 'explicitTransaction') {
        const results = {};
        for (const sql of ['BEGIN', 'COMMIT']) {
          try {
            results[sql] = { result: await env.DB.prepare(sql).run() };
          } catch (error) {
            results[sql] = { error: String(error.message) };
          }
        }
        return Response.json(results);
      }
      if (input.action === 'crashAfterCommit') {
        const prior = await env.DB.prepare('SELECT operation_id FROM "operation_ledger" WHERE operation_id = ?')
          .bind(input.operationId).first();
        if (prior) return Response.json({ status: 'already-committed', prior });
        await env.DB.prepare('INSERT INTO "operation_ledger" (operation_id, revision) VALUES (?, ?)')
          .bind(input.operationId, input.revision).run();
        return new Response('simulated lost acknowledgment after commit', { status: 503 });
      }
      return Response.json({ error: 'unknown action' }, { status: 400 });
    } catch (error) {
      return Response.json({ error: String(error.message), name: error.name });
    }
  }
};
`;

let workerProcess;
let baseUrl;
const faultyLoop = globalThis.process.argv.slice(2).includes('--faulty');
let faultyCheckInjected = false;

const evidence = {
  prototype: 'PROTOTYPE issue #219 — disposable local Wrangler/Miniflare/workerd D1 binding',
  baseCommit: '638e599',
  environment: {
    runtime: globalThis.process.version,
    databaseBinding: 'DB',
    workerRuntime: 'Wrangler local mode -> Miniflare/workerd',
    databaseId: 'synthetic-local-id-only',
    scratchDirectory: scratch,
    scratchCleanup:
      'the mkdtemp root is removed in finally; evidence JSON is kept separately in OS tmp',
    evidencePath,
    cloudflareRemoteAccess: false,
    faultInjection: faultyLoop ? '--faulty (expected non-zero exit)' : null,
  },
  cloudflareDocumentedLimits: {
    columnsPerTable: 100,
    source: 'https://developers.cloudflare.com/d1/platform/limits/ (retrieved 2026-10-25)',
    localParityAssumed: false,
  },
  states: [],
  guaranteesObserved: [],
  notDemonstrated: [
    'atomicity between independent Worker invocations beyond the tested D1 batch boundary',
    'remote D1 behavior, queue overload, latency, and real distributed concurrency',
    'D1 Time Travel, restore cancellation, production bookmarks/replication',
    'Miniflare local 100-column behavior is not the remote D1 limit contract',
  ],
};

const call = async (body) => {
  const response = await globalThis.fetch(`${baseUrl}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({ body: 'non-JSON response' }));
  return response.status === 200 ? result : { httpStatus: response.status, body: result };
};

const record = async (name, operation, validate = () => []) => {
  const result = await operation();
  const snapshot = await call({
    action: 'statements',
    statements: [
      {
        sql: "SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        mode: 'all',
      },
      { sql: 'SELECT * FROM "schema_catalog" ORDER BY collection_id', mode: 'all' },
      { sql: 'PRAGMA quick_check', mode: 'all' },
    ],
  });
  const checks = await validate(result, snapshot);
  if (faultyLoop && !faultyCheckInjected && checks.length > 0) {
    checks[0] = { ...checks[0], passed: false, injected: true };
    faultyCheckInjected = true;
  }
  const state = {
    name,
    result,
    snapshot,
    verdict: checks.every((item) => item.passed) ? 'pass' : 'fail',
    checks,
  };
  evidence.states.push(state);
  globalThis.console.log(JSON.stringify(state));
  if (state.verdict === 'fail') {
    throw new Error(`Prototype observation failed checks for ${name}`);
  }
  return result;
};

const check = (name, actual, expected, passed = undefined) => ({
  name,
  passed:
    passed ?? (Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)),
  expected,
  actual,
});

const rows = (response, resultIndex = 0) => response?.results?.[resultIndex]?.results ?? [];

const exec = (sql, values = undefined, mode = 'run') =>
  call({ action: 'statements', statements: [{ sql, values, mode }] });

try {
  const args = globalThis.process.argv.slice(2);
  if (args.some((argument) => argument !== '--faulty')) {
    throw new Error('Supported optional argument: --faulty');
  }
  await writeFile(workerPath, worker);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: 'd1-schema-219-prototype',
        main: 'worker.mjs',
        compatibility_date: '2026-10-25',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'd1-schema-219-scratch',
            database_id: databaseId,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const wranglerPath = new globalThis.URL(
    '../../node_modules/wrangler/bin/wrangler.js',
    import.meta.url,
  ).pathname;
  const statePath = join(scratch, 'local-d1-state');
  const startupOutput = [];
  workerProcess = spawn(
    globalThis.process.execPath,
    [
      wranglerPath,
      'dev',
      '--local',
      '--config',
      configPath,
      '--ip',
      '127.0.0.1',
      '--port',
      '0',
      '--persist-to',
      statePath,
    ],
    {
      cwd: scratch,
      env: {
        PATH: globalThis.process.env.PATH,
        HOME: scratch,
        TMPDIR: scratch,
        CI: '1',
        CLOUDFLARE_API_TOKEN: '',
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error(`Wrangler local startup timed out: ${startupOutput.join('')}`)),
      30000,
    );
    const inspect = (chunk) => {
      const text = chunk.toString();
      startupOutput.push(text);
      const match = text.match(/Ready on (https?:\/\/[^\s]+)/);
      if (match) {
        globalThis.clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    workerProcess.stdout.on('data', inspect);
    workerProcess.stderr.on('data', inspect);
    workerProcess.once('error', (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
    workerProcess.once('exit', (code) => {
      globalThis.clearTimeout(timeout);
      reject(new Error(`Wrangler exited before startup (${code}): ${startupOutput.join('')}`));
    });
  });
  evidence.environment.localWorkerUrl = baseUrl;

  await record(
    'bootstrap-catalog-and-ledger',
    () =>
      call({
        action: 'batch',
        statements: [
          {
            sql: 'CREATE TABLE "schema_catalog" (collection_id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL)',
          },
          {
            sql: 'CREATE TABLE "operation_ledger" (operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE)',
          },
          {
            sql: 'INSERT INTO "schema_catalog" VALUES (?, ?, ?)',
            values: ['coll_219', 'sample', 0],
          },
          { sql: 'CREATE TABLE "records" (id TEXT PRIMARY KEY, value TEXT NOT NULL)' },
          { sql: 'CREATE UNIQUE INDEX "records_value_unique" ON "records" (value)' },
          { sql: 'CREATE INDEX "records_id_idx" ON "records" (id)' },
          { sql: 'INSERT INTO "records" VALUES (?, ?)', values: ['r1', 'preserve-me'] },
        ],
      }),
    async (result) => [
      check(
        'all bootstrap batch statements succeeded',
        result.results?.every((item) => item.success) ?? false,
        true,
      ),
      check(
        'sample row was inserted',
        rows(await exec('SELECT id, value FROM "records" WHERE id = ?', ['r1'], 'all')),
        [{ id: 'r1', value: 'preserve-me' }],
      ),
    ],
  );

  await record('dynamic-identifiers-validated-quoted-values-bound', async () => {
    const identifier = 'records';
    const validIdentifier = /^[a-z][a-z0-9_]{0,62}$/.test(identifier);
    if (!validIdentifier) throw new Error('identifier rejected by allowlist');
    const quotedIdentifier = `"${identifier.replaceAll('"', '""')}"`;
    const injectedValue = 'value\'; DROP TABLE "records"; --';
    const result = await exec(
      `SELECT id FROM ${quotedIdentifier} WHERE value = ?`,
      [injectedValue],
      'all',
    );
    return {
      result,
      evidence: { identifier, validIdentifier, quotedIdentifier, maliciousLookingValueBound: true },
    };
  });

  await record('rename-table-and-indexes', () =>
    call({
      action: 'batch',
      statements: [
        { sql: 'ALTER TABLE "records" RENAME TO "records_renamed"' },
        { sql: 'ALTER TABLE "records_renamed" RENAME TO "records"' },
      ],
    }),
  );

  await record(
    'rename-index-by-drop-create',
    () =>
      call({
        action: 'batch',
        statements: [
          { sql: 'DROP INDEX "records_id_idx"' },
          { sql: 'CREATE INDEX "records_id_renamed_idx" ON "records" (id)' },
          { sql: 'DROP INDEX "records_id_renamed_idx"' },
          { sql: 'CREATE INDEX "records_id_idx" ON "records" (id)' },
        ],
      }),
    (result, snapshot) => [
      check(
        'index drop/create batch succeeded',
        result.results?.every((item) => item.success) ?? false,
        true,
      ),
      check(
        'replacement index exists after logical rename',
        rows(snapshot, 0).some((item) => item.name === 'records_id_idx'),
        true,
      ),
    ],
  );

  await record(
    'prepared-statements-across-rename-add-drop',
    () => call({ action: 'preparedAcrossDdl' }),
    (result) => [
      check('prepared query initially read the original row', result.beforeResult, {
        id: 'r1',
        value: 'preserve-me',
      }),
      check(
        'prepared query invalidated by column rename',
        result.staleAfterRename?.error?.includes('no such column: value') ?? false,
        true,
      ),
      check(
        'prepared query invalidated by column drop',
        result.staleAfterDrop?.error?.includes('no such column: temporary') ?? false,
        true,
      ),
    ],
  );

  await record('rename-column-and-add-column', () =>
    call({
      action: 'batch',
      statements: [
        { sql: 'ALTER TABLE "records" RENAME COLUMN "renamed_value" TO "value"' },
        { sql: 'ALTER TABLE "records" ADD COLUMN "added" TEXT NOT NULL DEFAULT \'defaulted\'' },
      ],
    }),
  );

  await record(
    'rebuild-incompatible-type-change-and-verify-data',
    async () => {
      const before = await exec(
        'SELECT id, value, added FROM "records" ORDER BY id',
        undefined,
        'all',
      );
      const rebuild = await call({
        action: 'batch',
        statements: [
          {
            sql: 'CREATE TABLE "records_next" (id TEXT PRIMARY KEY, value INTEGER NOT NULL, added TEXT NOT NULL DEFAULT \'defaulted\')',
          },
          {
            sql: 'INSERT INTO "records_next" (id, value, added) SELECT id, length(value), added FROM "records"',
          },
          { sql: 'DROP TABLE "records"' },
          { sql: 'ALTER TABLE "records_next" RENAME TO "records"' },
          { sql: 'CREATE UNIQUE INDEX "records_value_unique" ON "records" (value)' },
          { sql: 'CREATE INDEX "records_id_idx" ON "records" (id)' },
        ],
      });
      const after = await exec(
        'SELECT id, value, added FROM "records" ORDER BY id',
        undefined,
        'all',
      );
      return {
        rebuild,
        before,
        after,
        dataTransformed: after.results?.[0]?.results?.[0]?.value === 11,
      };
    },
    (result) => [
      check(
        'incompatible rebuild batch succeeded',
        result.rebuild.results?.every((item) => item.success) ?? false,
        true,
      ),
      check('source row before rebuild', rows(result.before), [
        { id: 'r1', value: 'preserve-me', added: 'defaulted' },
      ]),
      check('row and converted value after rebuild', rows(result.after), [
        { id: 'r1', value: 11, added: 'defaulted' },
      ]),
    ],
  );

  await record(
    'batch-ddl-catalog-rollback-injected-failure',
    async () => {
      const batch = await call({
        action: 'batch',
        statements: [
          { sql: 'CREATE TABLE "rollback_probe" (id TEXT PRIMARY KEY)' },
          {
            sql: 'INSERT INTO "schema_catalog" VALUES (?, ?, ?)',
            values: ['rollback', 'must-not-persist', 1],
          },
          { sql: 'CREATE TABLE "records" (id TEXT)' },
        ],
      });
      const after = await call({
        action: 'statements',
        statements: [
          {
            sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
            values: ['table', 'rollback_probe'],
            mode: 'all',
          },
          {
            sql: 'SELECT collection_id FROM "schema_catalog" WHERE collection_id = ?',
            values: ['rollback'],
            mode: 'all',
          },
          { sql: 'SELECT id, value FROM "records" WHERE id = ?', values: ['r1'], mode: 'all' },
        ],
      });
      return {
        batch,
        rollbackTable: rows(after, 0),
        rollbackCatalog: rows(after, 1),
        preservedRecord: rows(after, 2),
      };
    },
    (result) => [
      check(
        'injected DDL failure reported',
        result.batch.error?.includes('already exists') ?? false,
        true,
      ),
      check('failed batch did not create rollback table', result.rollbackTable, []),
      check('failed batch did not insert catalog row', result.rollbackCatalog, []),
      check('pre-existing record remains unchanged', result.preservedRecord, [
        { id: 'r1', value: 11 },
      ]),
    ],
  );

  await record(
    'two-concurrent-revision-cas-attempts',
    async () => {
      const contender = (operationId) =>
        call({
          action: 'batch',
          statements: [
            {
              sql: 'UPDATE "schema_catalog" SET revision = revision + 1 WHERE collection_id = ? AND revision = ?',
              values: ['coll_219', 0],
            },
            {
              sql: 'INSERT INTO "operation_ledger" (operation_id, revision) SELECT ?, 1 WHERE changes() = 1 ON CONFLICT(operation_id) DO NOTHING',
              values: [operationId],
            },
          ],
        });
      const attempts = await Promise.all([contender('attempt_a'), contender('attempt_b')]);
      return {
        attempts,
        catalog: await exec('SELECT * FROM "schema_catalog"', undefined, 'all'),
        ledger: await exec(
          'SELECT * FROM "operation_ledger" ORDER BY operation_id',
          undefined,
          'all',
        ),
      };
    },
    (result) => {
      const ledger = rows(result.ledger);
      const catalog = rows(result.catalog);
      const changedAttempts = result.attempts.filter(
        (attempt) => attempt.results?.[0]?.meta?.changes === 1,
      ).length;
      return [
        check('exactly one CAS attempt changed the revision', changedAttempts, 1),
        check(
          'one operation ledger row at revision 1',
          ledger,
          [{ operation_id: ledger[0]?.operation_id, revision: 1 }],
          ledger.length === 1 && ledger[0]?.revision === 1,
        ),
        check('catalog revision is exactly 1', catalog[0]?.revision ?? null, 1),
      ];
    },
  );

  const committed = await record(
    'simulated-crash-after-commit-before-ack',
    async () => {
      const response = await call({
        action: 'crashAfterCommit',
        operationId: 'crash_recovery',
        revision: 99,
      });
      const ledger = await exec(
        'SELECT operation_id, revision FROM "operation_ledger" WHERE operation_id = ?',
        ['crash_recovery'],
        'all',
      );
      return { response, ledger: rows(ledger) };
    },
    (result) => [
      check('first invocation lost its response after commit', result.response.httpStatus, 503),
      check('operation was committed before response loss', result.ledger, [
        { operation_id: 'crash_recovery', revision: 99 },
      ]),
    ],
  );
  await record(
    'retry-after-simulated-crash-is-idempotent',
    async () => {
      const retry = await call({
        action: 'crashAfterCommit',
        operationId: 'crash_recovery',
        revision: 99,
      });
      const ledger = await exec(
        'SELECT operation_id, revision FROM "operation_ledger" WHERE operation_id = ?',
        ['crash_recovery'],
        'all',
      );
      return { first: committed.response, retry, ledger: rows(ledger) };
    },
    (result) => [
      check(
        'retry acknowledged pre-existing idempotency key',
        result.retry.status,
        'already-committed',
      ),
      check('retry did not duplicate committed operation', result.ledger, [
        { operation_id: 'crash_recovery', revision: 99 },
      ]),
    ],
  );

  await record('sqlite-master-and-pragma-introspection', async () =>
    call({
      action: 'statements',
      statements: [
        { sql: 'SELECT name, type, sql FROM sqlite_master ORDER BY type, name', mode: 'all' },
        { sql: 'PRAGMA table_xinfo("records")', mode: 'all' },
        { sql: 'PRAGMA index_list("records")', mode: 'all' },
        { sql: 'PRAGMA foreign_key_list("records")', mode: 'all' },
        { sql: 'PRAGMA foreign_key_check', mode: 'all' },
        { sql: 'PRAGMA quick_check', mode: 'all' },
      ],
    }),
  );

  await record(
    'documented-100-column-limit-local-observation',
    async () => {
      const columns = Array.from({ length: 100 }, (_, index) => `"c${index}" TEXT`).join(', ');
      const create = await exec(`CREATE TABLE "column_limit_probe" (${columns})`);
      const at100 = await exec('PRAGMA table_xinfo("column_limit_probe")', undefined, 'all');
      const hundredFirst = await exec('ALTER TABLE "column_limit_probe" ADD COLUMN "c100" TEXT');
      const after101 = await exec('PRAGMA table_xinfo("column_limit_probe")', undefined, 'all');
      const drop = await exec('DROP TABLE IF EXISTS "column_limit_probe"');
      return {
        create,
        localColumnCountAt100: rows(at100).length,
        attempt101: hundredFirst,
        localColumnCountAfter101Attempt: rows(after101).length,
        drop,
        note: 'D1 documents max 100; this is local Miniflare observation only and does not establish remote parity.',
      };
    },
    (result) => [
      check(
        'local table creation at 100 columns succeeded',
        result.create.results?.[0]?.success ?? false,
        true,
      ),
      check('local table has 100 physical columns', result.localColumnCountAt100, 100),
      check(
        'local 101st-column attempt was rejected',
        result.attempt101.error?.includes('too many columns') ?? false,
        true,
      ),
      check(
        'local table remains at 100 columns after rejected alter',
        result.localColumnCountAfter101Attempt,
        100,
      ),
      check(
        'local column-limit scratch table was dropped',
        result.drop.results?.[0]?.success ?? false,
        true,
      ),
    ],
  );

  await record(
    'explicit-begin-commit-attempt-results',
    () => call({ action: 'explicitTransaction' }),
    (result) => [
      check(
        'explicit BEGIN rejected by D1 binding',
        result.BEGIN?.error?.includes('D1_ERROR') ?? false,
        true,
      ),
      check(
        'explicit COMMIT rejected by D1 binding',
        result.COMMIT?.error?.includes('D1_ERROR') ?? false,
        true,
      ),
    ],
  );

  await record('drop-index-column-and-table', async () => {
    const dropColumn = await exec('ALTER TABLE "records" DROP COLUMN "added"');
    const dropIndex = await exec('DROP INDEX "records_value_unique"');
    const dropTable = await exec('DROP TABLE "records"');
    return { dropColumn, dropIndex, dropTable };
  });

  evidence.guaranteesObserved.push(
    'D1 batch executes the tested multi-statement DDL/catalog sequence in the local Miniflare binding.',
    'The injected duplicate-table failure yielded final catalog/physical state in the JSON snapshots for rollback inspection.',
    'The concurrent CAS scenario records both invocations, final revision, and ledger state; only this local scheduling was observed.',
    'The retry-after-simulated-crash scenario checks a durable ledger before repeating the write.',
    'Every state snapshot includes sqlite_master, catalog, and quick_check; dedicated PRAGMAs are captured separately.',
  );
  if (faultyLoop && !faultyCheckInjected) {
    throw new Error('Fault injection did not reach a check to invert');
  }
} catch (error) {
  evidence.fatalError = { name: error.name, message: error.message };
  globalThis.process.exitCode = 1;
  globalThis.console.error(JSON.stringify(evidence.fatalError));
} finally {
  evidence.finalVerdict =
    evidence.fatalError || evidence.states.some((state) => state.verdict === 'fail')
      ? 'fail'
      : 'pass';
  evidence.completedCheckCount = evidence.states.reduce(
    (count, state) => count + state.checks.filter((item) => item.passed).length,
    0,
  );
  evidence.failedCheckCount = evidence.states.reduce(
    (count, state) => count + state.checks.filter((item) => !item.passed).length,
    0,
  );
  try {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    globalThis.console.log(
      JSON.stringify({
        evidencePath,
        finalStateCount: evidence.states.length,
        finalVerdict: evidence.finalVerdict,
        fatalError: evidence.fatalError ?? null,
      }),
    );
  } finally {
    try {
      if (workerProcess && workerProcess.exitCode === null && workerProcess.signalCode === null) {
        const stopped = once(workerProcess, 'exit');
        workerProcess.kill('SIGTERM');
        await stopped;
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
