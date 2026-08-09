#!/usr/bin/env node
// Put one note per built-in template into a local account, so the templates can be looked
// at side by side instead of applied one at a time through the editor.
//
// Local only, and it refuses anything that is not localhost - this signs an account in and
// writes notes, which is not something to point at a deployment by accident.
//
// Why it exists: `npm run test -w server` runs `DROP SCHEMA public CASCADE` against the
// same database the dev server uses, so running the suite deletes whatever account you
// were reviewing with. Rather than re-doing it by hand, run this.
//
//   node scripts/seed-review-notes.mjs
//   node scripts/seed-review-notes.mjs --base http://localhost:4780 --email me@localhost.test
//
// NOTE: the built-in templates are seeded once per SERVER PROCESS and the result is
// memoised, so after a database reset the running API still believes it has seeded and
// serves an empty list. Restart the API (touch a file under server/src) before running
// this, or it will tell you there are no templates.

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const base = arg('base', 'http://localhost:4780');
const email = arg('email', 'review@localhost.test');
const password = arg('password', 'localdevpassword123');

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
  console.error(`Refusing to run against ${base}. This script is for a local server only.`);
  process.exit(1);
}

// One cookie jar, hand-rolled: node's fetch does not keep cookies between calls, and the
// session cookie is the only thing making these requests authenticated.
let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return body;
}

async function signInOrUp() {
  try {
    await call('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Review', email, password }) });
    console.log(`Created ${email}`);
  } catch (err) {
    if (!String(err).includes('409')) throw err;
    await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    console.log(`Signed in as ${email}`);
  }
}

await signInOrUp();

const { templates } = await call('/api/templates');
if (!templates.length) {
  console.error('The server returned no templates. Restart the API so its seed runs again, then retry.');
  process.exit(1);
}

const { notebooks } = await call('/api/notebooks');
const notebookId = notebooks[0].id;
const existing = new Set((await call(`/api/notes?notebookId=${notebookId}`)).notes.map((n) => n.title));

for (const tpl of templates) {
  if (existing.has(tpl.name)) {
    console.log(`  = ${tpl.name} (already there)`);
    continue;
  }
  const { note } = await call('/api/notes', { method: 'POST', body: JSON.stringify({ notebookId, title: '' }) });
  await call(`/api/notes/${note.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: tpl.name, contentJson: tpl.contentJson }),
  });
  console.log(`  + ${tpl.name}  ->  /note/${note.id}`);
}

console.log(`\n${templates.length} templates available. Sign in as ${email} / ${password}.`);
