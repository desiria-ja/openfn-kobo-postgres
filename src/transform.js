/**
 * Kobo submission -> rows for PostgreSQL.
 *
 * These are pure functions with no OpenFn dependency, so they can be unit
 * tested directly. The job in `jobs/upsert-postgres.js` inlines the same logic
 * so that it stays copy-pasteable into a Lightning workflow.
 */

/** Kobo metadata keys that we lift into typed columns or deliberately drop. */
const HANDLED_KEYS = new Set([
  '_id',
  '_uuid',
  '_submission_time',
  '_xform_id_string',
  '_attachments',
  '_geolocation',
  'start',
  'end',
]);

/** Empty-ish values that should become NULL rather than an empty string. */
export function nullify(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isNaN(value)) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'NaN' || trimmed === 'n/a') return null;
  return trimmed;
}

/**
 * Kobo group keys look like `group_health/child_name`. Postgres identifiers
 * can't contain `/`, so flatten to `group_health__child_name`.
 */
export function normalizeKey(key) {
  return String(key)
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '__')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_{3,}/g, '__')
    .toLowerCase();
}

/**
 * Kobo geopoint is a single string: "lat lon altitude accuracy".
 * `_geolocation` is `[lat, lon]` (either value may be null).
 */
export function parseGeo(submission) {
  const empty = { latitude: null, longitude: null, altitude: null, gps_accuracy: null };

  const point = Object.entries(submission).find(
    ([key, value]) =>
      typeof value === 'string' &&
      /^\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){0,2}\s*$/.test(value) &&
      /gps|geo|location|point|coord/i.test(key)
  );

  if (point) {
    const [lat, lon, alt, acc] = point[1].trim().split(/\s+/).map(Number);
    return {
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      altitude: Number.isFinite(alt) ? alt : null,
      gps_accuracy: Number.isFinite(acc) ? acc : null,
    };
  }

  const geo = submission._geolocation;
  if (Array.isArray(geo) && geo.length >= 2) {
    const [lat, lon] = geo;
    return {
      ...empty,
      latitude: typeof lat === 'number' ? lat : null,
      longitude: typeof lon === 'number' ? lon : null,
    };
  }

  return empty;
}

/** ISO-ish timestamp or null. Postgres will reject an empty string. */
export function toTimestamp(value) {
  const v = nullify(value);
  if (v === null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * One submission -> one parent row.
 *
 * `raw_submission` keeps the whole payload so nothing is lost when the form
 * changes shape. The flattened answer columns are additive on top of that.
 */
export function toParentRow(submission, { formId } = {}) {
  const xform = nullify(submission._xform_id_string) ?? nullify(formId);
  if (!xform) throw new Error('missing _xform_id_string (and no formId fallback)');
  if (submission._id === undefined || submission._id === null) {
    throw new Error(`submission has no _id: ${JSON.stringify(submission).slice(0, 120)}`);
  }

  const answers = {};
  for (const [key, value] of Object.entries(submission)) {
    if (HANDLED_KEYS.has(key)) continue;
    if (Array.isArray(value) || (value && typeof value === 'object')) continue;
    answers[normalizeKey(key)] = nullify(value);
  }

  return {
    xform_id_string: xform,
    submission_id: Number(submission._id),
    submission_uuid: nullify(submission._uuid),
    submitted_at: toTimestamp(submission._submission_time),
    started_at: toTimestamp(submission.start),
    ended_at: toTimestamp(submission.end),
    ...parseGeo(submission),
    answers,
    raw_submission: submission,
  };
}

/** One submission -> zero or more attachment rows. */
export function toAttachmentRows(submission, { formId } = {}) {
  const xform = nullify(submission._xform_id_string) ?? nullify(formId);
  const list = Array.isArray(submission._attachments) ? submission._attachments : [];

  return list
    .filter(a => a && a.id !== undefined && a.id !== null)
    .map(a => ({
      xform_id_string: xform,
      submission_id: Number(submission._id),
      attachment_id: Number(a.id),
      filename: nullify(a.filename),
      mimetype: nullify(a.mimetype),
      download_url: nullify(a.download_url ?? a.download_large_url),
      raw_attachment: a,
    }));
}

/**
 * Whole batch -> { parents, attachments }, both de-duplicated on their unique
 * key. If a batch contains the same submission twice, Postgres rejects the
 * statement ("ON CONFLICT DO UPDATE command cannot affect row a second time")
 * rather than merging them — so dedupe before the insert, not in the database.
 */
export function buildRows(submissions, options = {}) {
  const parents = new Map();
  const attachments = new Map();

  for (const submission of submissions ?? []) {
    const row = toParentRow(submission, options);
    parents.set(`${row.xform_id_string}|${row.submission_id}`, row);

    for (const a of toAttachmentRows(submission, options)) {
      attachments.set(`${a.xform_id_string}|${a.submission_id}|${a.attachment_id}`, a);
    }
  }

  return { parents: [...parents.values()], attachments: [...attachments.values()] };
}
