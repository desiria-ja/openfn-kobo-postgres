/**
 * OpenFn job — Kobo submissions -> PostgreSQL (parent + attachments), idempotent.
 *
 *   openfn jobs/upsert-postgres.js -a postgresql -s tmp/kobo-output.json -o tmp/out.json
 *
 * Expects `state.data` to be the array returned by
 * `getSubmissions(formId)` in the kobotoolbox adaptor.
 *
 * Run it twice with the same input: the unique constraints in sql/schema.sql
 * turn the second run into UPDATEs, so row counts stay flat.
 *
 * The transform below is the same code as src/transform.js — that file is what
 * the test suite exercises. It is inlined here so this job can be pasted
 * straight into a Lightning workflow with no imports.
 */

fn(state => {
  const HANDLED = new Set([
    '_id', '_uuid', '_submission_time', '_xform_id_string',
    '_attachments', '_geolocation', 'start', 'end',
  ]);

  const nullify = v => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' && Number.isNaN(v)) return null;
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' || t === 'NaN' || t === 'n/a' ? null : t;
  };

  const toTimestamp = v => {
    const s = nullify(v);
    if (s === null) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const parseGeo = s => {
    const empty = { latitude: null, longitude: null, altitude: null, gps_accuracy: null };
    const point = Object.entries(s).find(
      ([k, v]) =>
        typeof v === 'string' &&
        /^\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){0,2}\s*$/.test(v) &&
        /gps|geo|location|point|coord/i.test(k)
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
    const g = s._geolocation;
    if (Array.isArray(g) && g.length >= 2) {
      return {
        ...empty,
        latitude: typeof g[0] === 'number' ? g[0] : null,
        longitude: typeof g[1] === 'number' ? g[1] : null,
      };
    }
    return empty;
  };

  // group/question -> group__question, so the key is usable as a column name
  const normalizeKey = k =>
    String(k)
      .replace(/^\/+|\/+$/g, '')
      .replace(/\//g, '__')
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/_{3,}/g, '__')
      .toLowerCase();

  const HANDLED_OR_META = k => HANDLED.has(k);

  const submissions = Array.isArray(state.data) ? state.data : [];
  const parents = new Map();
  const attachments = new Map();

  for (const s of submissions) {
    const xform = nullify(s._xform_id_string);
    if (!xform) throw new Error('submission is missing _xform_id_string');
    if (s._id === undefined || s._id === null) throw new Error('submission is missing _id');

    const id = Number(s._id);

    // Flattened, normalized answers. Kept as jsonb so a form change can never
    // break the insert; map them into real columns when you need to query them.
    const answers = {};
    for (const [k, v] of Object.entries(s)) {
      if (HANDLED_OR_META(k)) continue;
      if (Array.isArray(v) || (v && typeof v === 'object')) continue;
      answers[normalizeKey(k)] = nullify(v);
    }

    parents.set(`${xform}|${id}`, {
      xform_id_string: xform,
      submission_id: id,
      submission_uuid: nullify(s._uuid),
      submitted_at: toTimestamp(s._submission_time),
      started_at: toTimestamp(s.start),
      ended_at: toTimestamp(s.end),
      ...parseGeo(s),
      answers,
      raw_submission: s,
    });

    for (const a of Array.isArray(s._attachments) ? s._attachments : []) {
      if (!a || a.id === undefined || a.id === null) continue;
      const aid = Number(a.id);
      attachments.set(`${xform}|${id}|${aid}`, {
        xform_id_string: xform,
        submission_id: id,
        attachment_id: aid,
        filename: nullify(a.filename),
        mimetype: nullify(a.mimetype),
        download_url: nullify(a.download_url ?? a.download_large_url),
        raw_attachment: a,
      });
    }
  }

  console.log(
    `prepared ${parents.size} submissions and ${attachments.size} attachments`
  );

  return { ...state, parents: [...parents.values()], attachments: [...attachments.values()] };
});

// The second argument is the conflict target. Naming the constraint (rather
// than a column list) is what makes this stable when the schema grows.
upsertMany('kobo_submissions', 'ON CONSTRAINT kobo_submissions_unique', state => state.parents);

upsertMany('kobo_attachments', 'ON CONSTRAINT kobo_attachments_unique', state => state.attachments);
