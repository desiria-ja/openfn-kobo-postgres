/**
 * OpenFn job — pull submissions from KoboToolbox.
 *
 *   openfn jobs/fetch-kobo.js -a kobotoolbox -s tmp/state.json -o tmp/kobo.json
 *
 * Replace the form id below with your own. Per the adaptor docs the signature
 * is getSubmissions(formId, [options]) and formId is a string.
 *
 * Two things that come up on the forum:
 *
 * 1. formId is a plain string. Passing an object is a common cause of what
 *    surfaces as ERR_BAD_REQUEST.
 * 2. A 401 from a non-default server (for example the EU one) can also surface
 *    as a generic request error. If you get one, check the base URL in your
 *    credential and that the token has read access to the project.
 */

getSubmissions('aXk9TnR4Qm5wVGc2', { pageSize: 500 });

fn(state => {
  const rows = Array.isArray(state.data) ? state.data : [];
  console.log(`fetched ${rows.length} submissions`);
  return state;
});
