import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRows, nullify, normalizeKey, parseGeo, toTimestamp } from '../src/transform.js';

const submissions = JSON.parse(
  readFileSync(new URL('../fixtures/submissions.json', import.meta.url), 'utf8')
);

test('blank-ish answers become null', () => {
  assert.equal(nullify('   '), null);
  assert.equal(nullify(''), null);
  assert.equal(nullify('NaN'), null);
  assert.equal(nullify(NaN), null);
  assert.equal(nullify(undefined), null);
  assert.equal(nullify('boiling'), 'boiling');
  assert.equal(nullify(0), 0, 'zero is a real answer, not a blank');
});

test('group keys are flattened for use as column names', () => {
  assert.equal(normalizeKey('household/respondent_name'), 'household__respondent_name');
  assert.equal(normalizeKey('meta/instanceID'), 'meta__instanceid');
  assert.equal(normalizeKey('/leading/slash'), 'leading__slash');
});

test('geopoint string is split into four columns', () => {
  assert.deepEqual(parseGeo({ gps_point: '-1.286389 36.817223 1795.0 4.9' }), {
    latitude: -1.286389,
    longitude: 36.817223,
    altitude: 1795,
    gps_accuracy: 4.9,
  });
});

test('_geolocation is used when there is no geopoint answer', () => {
  assert.deepEqual(parseGeo({ _geolocation: [-1.2921, 36.8219] }), {
    latitude: -1.2921,
    longitude: 36.8219,
    altitude: null,
    gps_accuracy: null,
  });
});

test('missing or unparseable timestamps become null, not Invalid Date', () => {
  assert.equal(toTimestamp(''), null);
  assert.equal(toTimestamp('not a date'), null);
  assert.equal(toTimestamp('2026-04-12T08:31:07'), new Date('2026-04-12T08:31:07').toISOString());
});

test('fixture produces 2 parents and 6 attachments', () => {
  const { parents, attachments } = buildRows(submissions);
  assert.equal(parents.length, 2);
  assert.equal(attachments.length, 6);
  assert.equal(parents[0].submission_id, 481523);
  assert.equal(parents[0].xform_id_string, 'aXk9TnR4Qm5wVGc2');
  assert.equal(attachments[0].attachment_id, 9001);
});

test('duplicate submissions across pages are de-duplicated before the insert', () => {
  const { parents, attachments } = buildRows([...submissions, ...submissions]);
  assert.equal(parents.length, 2, 'ON CONFLICT cannot touch the same row twice in one statement');
  assert.equal(attachments.length, 6);
});

test('a submission without _id is rejected loudly', () => {
  assert.throws(() => buildRows([{ _xform_id_string: 'abc' }]), /_id/);
});

test('raw payload is preserved so nothing is lost when the form changes', () => {
  const { parents } = buildRows(submissions);
  assert.equal(parents[0].raw_submission['household/respondent_name'], 'Amina O.');
  assert.equal(parents[0].raw_submission['meta/instanceID'], submissions[0]['meta/instanceID']);
});
