# openfn-kobo-postgres

Idempotent bulk upsert of **KoboToolbox** submissions into **PostgreSQL**, for
[OpenFn](https://www.openfn.org/) workflows.

Load the same batch twice and you get the same rows — no duplicates, no manual
cleanup. Attachments land in their own table, keyed back to the submission.

## Why this exists

The adaptors already have what you need: `@openfn/language-postgresql` ships
`upsert`, `upsertMany` and `insertMany`. What comes up repeatedly on the
[community forum](https://community.openfn.org/) isn't a missing function — it's
the shape of the data in between:

- Kobo's `group/question` keys need double-quoting to survive as column names
- deciding what the idempotency key actually is
- getting attachments into a child table without orphaning them
- blank answers, `"NaN"`, and empty `start` timestamps failing at insert time
- re-running after a partial failure

So this is a worked example rather than a library.

## Layout

```
sql/schema.sql              parent + attachment tables, with the unique
                            constraints that make the upserts idempotent
jobs/fetch-kobo.js          pull submissions
jobs/upsert-postgres.js     transform + upsert — self-contained, paste-able
src/transform.js            the same transform as a plain module, so it can
                            be unit tested
fixtures/submissions.json   two synthetic submissions with six attachments
*-state.example.json        credential shapes for the two CLI steps; copies
                            live in tmp/, which is gitignored
test/                       unit tests + a round trip against a real Postgres
```

## Running it

Each step needs the credential for **its own** adaptor, so the two steps take
two different state files — the Kobo output can't be piped straight into the
second job.

```bash
psql "$DATABASE_URL" -f sql/schema.sql

mkdir -p tmp                                    # tmp/ is gitignored — credentials stay out of git
cp kobo-state.example.json tmp/kobo-state.json  # fill in your Kobo credential
cp pg-state.example.json   tmp/pg-state.json    # fill in your Postgres credential

# 1. pull submissions (set your form id at the top of jobs/fetch-kobo.js)
openfn jobs/fetch-kobo.js -a kobotoolbox -s tmp/kobo-state.json -o tmp/kobo.json

# 2. carry the submissions over to the Postgres credential
node -e "const f=require('fs'),m=(a,b)=>JSON.parse(f.readFileSync(a)); \
  const s=m('tmp/pg-state.json'); s.data=m('tmp/kobo.json').data; \
  f.writeFileSync('tmp/upsert-state.json',JSON.stringify(s,null,2))"

# 3. transform + upsert
openfn jobs/upsert-postgres.js -a postgresql -s tmp/upsert-state.json -o tmp/out.json
```

`jobs/upsert-postgres.js` expects `state.data` to be the array that
`getSubmissions(formId)` returns, and `state.configuration` to be the
[PostgreSQL credential](https://docs.openfn.org/adaptors/packages/postgresql-configuration-schema).
Inside Lightning this step doesn't apply — each step carries its own credential
already, and `state.data` is passed between them for you.

Requires the [OpenFn CLI](https://docs.openfn.org/documentation/cli-usage)
(`npm install -g @openfn/cli`) and a reachable PostgreSQL.

## Design notes

**The payload is kept twice, on purpose.** `raw_submission jsonb` is exactly
what Kobo sent, untouched. `answers jsonb` is the queryable copy: scalar fields
only — arrays and objects such as `_attachments` and `_geolocation` are skipped,
since they're handled elsewhere — with `group/question` flattened to
`group__question` and blanks turned into `null`. Kobo's own scalar metadata
(`_status`, `formhub/uuid`, and so on) rides along rather than being filtered,
so it's a superset of the answers and not a curated list:

```sql
SELECT answers->>'household__respondent_name' FROM kobo_submissions;
```

Neither one breaks when the form gains a question, and you can backfill a typed
column later from what's already stored.

**The idempotency key is `_id`, not `_uuid`.** Per the Kobo docs, editing a
submission updates its `_uuid` while the other metadata is retained — so keying
on `_uuid` can quietly give you a second row for the same response.

**Duplicates are removed before the insert, not by the database.** If a batch
contains the same submission twice, Postgres rejects the statement
(`ON CONFLICT DO UPDATE command cannot affect row a second time`) rather than
merging them, so the transform de-duplicates on the unique key first.

**The conflict target is the named constraint, not a column list.** Naming it
keeps the job working when the schema grows.

**Partial failures are recoverable by re-running.** If the parent upsert
succeeds and the attachment upsert fails, running the same batch again updates
the parents and inserts the missing children. There's a test for exactly that.

## What this does not cover

- **Repeat groups.** Only `_attachments` is handled as a child table. Repeat
  groups need a stable per-row identifier to be upserted safely, and the
  representation varies by form, so this leaves them out rather than guess.
- **MySQL.** `@openfn/language-mysql` has `upsertMany` too, but its signature
  differs — `upsertMany(table, data)` against `upsertMany(table, uuid, data,
  [options])` in the PostgreSQL adaptor — so the jobs here are not portable
  as-is. Tested against Postgres only.
- **Attachment downloads.** Only metadata and URLs are stored.

## Tests

```bash
npm install
npm test
```

The round-trip test starts a real PostgreSQL server via
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) — no
Docker and no system install — then loads the fixture batch three times and
checks the row counts don't move.

Fixture data is synthetic; see `fixtures/README.md`.

## License

MIT
