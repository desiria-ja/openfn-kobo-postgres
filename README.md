# openfn-kobo-postgres

Idempotent bulk upsert of **KoboToolbox** submissions into **PostgreSQL**, for
[OpenFn](https://www.openfn.org/) workflows.

Run the same batch twice and you get the same rows — no duplicates, no manual
cleanup. Attachments land in their own table, keyed back to the submission.

## Why this exists

The adaptors already have what you need: `@openfn/language-postgresql` ships
`upsert`, `upsertMany` and `insertMany`. The part that keeps coming up on the
[community forum](https://community.openfn.org/) isn't a missing function — it's
the shape of the data in between:

- flattening Kobo's `group/question` keys into something Postgres will accept as
  a column name
- deciding what the idempotency key actually is
- getting attachments into a child table without orphaning them
- not blowing up on blank answers, `"NaN"`, or an empty `start` timestamp
- re-running after a partial failure

So this is a worked example rather than a library.

## Layout

```
sql/schema.sql              parent + attachment tables, with the unique
                            constraints that make the upserts idempotent
jobs/upsert-postgres.js     the OpenFn job — self-contained, paste-able
src/transform.js            the same transform as a plain module, so it can
                            be unit tested
fixtures/submissions.json   two realistic submissions with six attachments
test/                       unit tests + a round trip against a real Postgres
```

## Running it

```bash
psql "$DATABASE_URL" -f sql/schema.sql

openfn jobs/fetch-kobo.js      -a kobotoolbox -s tmp/state.json  -o tmp/kobo.json
openfn jobs/upsert-postgres.js -a postgresql  -s tmp/kobo.json   -o tmp/out.json
```

`jobs/upsert-postgres.js` expects `state.data` to be the array that
`getSubmissions(formId)` returns.

## Design notes

**The idempotency key is `_id`, not `_uuid`.** Kobo's `_id` is unique per server
and stable. `_uuid` can change when a submission is edited during data cleaning,
which would silently give you a second row for the same response.

**The whole payload is kept in `raw_submission jsonb`.** Forms change. Typed
columns are additive on top of the raw record, so a new question never costs you
data — and you can backfill a column later from what's already stored.

**Duplicates are removed before the insert, not by the database.** Paginated
Kobo calls can hand you the same submission twice. Postgres rejects an
`INSERT ... ON CONFLICT` that touches the same row twice in one statement
(`cannot affect row a second time`), so the transform de-duplicates on the
unique key first.

**The conflict target is the named constraint, not a column list.** Naming it
keeps the job working when the schema grows.

**Partial failures are recoverable by re-running.** If the parent upsert
succeeds and the attachment upsert fails, running the same batch again updates
the parents and inserts the missing children. There's a test for exactly that.

## What this does not cover

- **Repeat groups.** Only `_attachments` is handled as a child table. Repeat
  groups need a stable per-row identifier to be upserted safely, and the
  representation varies by form, so guessing at it would be worse than leaving
  it out.
- **MySQL.** `@openfn/language-mysql` has `upsertMany` too and the same shape
  applies, but this example is tested against Postgres only.
- **Attachment downloads.** Only the metadata and URLs are stored.

## Tests

```bash
npm install
npm test
```

The round-trip test starts a real PostgreSQL server via
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) — no
Docker and no system install — then loads the fixture batch three times and
checks the row counts don't move.

## License

MIT
