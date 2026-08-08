/**
 * Runs against a real PostgreSQL server (downloaded and started by
 * embedded-postgres — no Docker, no system install).
 *
 * The claim under test: running the same batch twice must not create
 * duplicate rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { buildRows } from '../src/transform.js';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const submissions = JSON.parse(
  readFileSync(new URL('../fixtures/submissions.json', import.meta.url), 'utf8')
);

/** Mirrors what the postgresql adaptor's upsertMany() emits. */
async function upsertMany(client, table, constraint, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const values = [];
  const tuples = rows.map(
    row =>
      `(${columns
        .map(c => {
          const v = row[c];
          values.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
          return `$${values.length}`;
        })
        .join(', ')})`
  );
  const updates = columns
    .filter(c => !constraint.includes(c))
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  await client.query(
    `INSERT INTO ${table} (${columns.map(c => `"${c}"`).join(', ')})
     VALUES ${tuples.join(', ')}
     ON CONFLICT ON CONSTRAINT ${constraint}
     DO UPDATE SET ${updates}`,
    values
  );
}

async function load(client, rows) {
  await upsertMany(client, 'kobo_submissions', 'kobo_submissions_unique', rows.parents);
  await upsertMany(client, 'kobo_attachments', 'kobo_attachments_unique', rows.attachments);
}

const count = async (client, table) =>
  Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

test('same batch loaded twice does not duplicate rows', async t => {
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'kobo-pg-')),
    user: 'postgres',
    password: 'postgres',
    port: 54329,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kobo');
  const client = pg.getPgClient();
  client.database = 'kobo';

  const { Client } = await import('pg');
  const db = new Client({
    host: 'localhost',
    port: 54329,
    user: 'postgres',
    password: 'postgres',
    database: 'kobo',
  });
  await db.connect();

  t.after(async () => {
    await db.end().catch(() => {});
    await pg.stop().catch(() => {});
  });

  await db.query(schema);

  const rows = buildRows(submissions);
  assert.equal(rows.parents.length, 2, 'fixture should produce 2 parent rows');
  assert.equal(rows.attachments.length, 6, 'fixture should produce 6 attachment rows');

  // First run — inserts.
  await load(db, rows);
  assert.equal(await count(db, 'kobo_submissions'), 2);
  assert.equal(await count(db, 'kobo_attachments'), 6);

  // Second run, identical input — must update in place, not insert again.
  await load(db, rows);
  assert.equal(await count(db, 'kobo_submissions'), 2, 'parents duplicated on re-run');
  assert.equal(await count(db, 'kobo_attachments'), 6, 'attachments duplicated on re-run');

  // Third run with a changed answer — still 2 rows, but the payload is updated.
  const edited = structuredClone(submissions);
  edited[0]['household/household_size'] = '7';
  await load(db, buildRows(edited));
  assert.equal(await count(db, 'kobo_submissions'), 2);
  const { rows: check } = await db.query(
    `SELECT raw_submission->>'household/household_size' AS size
       FROM kobo_submissions WHERE submission_id = 481523`
  );
  assert.equal(check[0].size, '7', 'raw_submission should reflect the edit');

  // Recovery: attachments failing after parents succeed must be re-runnable.
  await db.query('DELETE FROM kobo_attachments WHERE submission_id = 481523');
  assert.equal(await count(db, 'kobo_attachments'), 3);
  await load(db, rows);
  assert.equal(await count(db, 'kobo_attachments'), 6, 're-run should restore children');

  // Typed columns should be populated, and blank answers should be NULL.
  const { rows: typed } = await db.query(
    `SELECT latitude, longitude, altitude, gps_accuracy, submitted_at, started_at
       FROM kobo_submissions WHERE submission_id = 481523`
  );
  assert.equal(typed[0].latitude, -1.286389);
  assert.equal(typed[0].longitude, 36.817223);
  assert.equal(typed[0].altitude, 1795);
  assert.equal(typed[0].gps_accuracy, 4.9);
  assert.ok(typed[0].submitted_at instanceof Date);
  assert.ok(typed[0].started_at instanceof Date);
});
