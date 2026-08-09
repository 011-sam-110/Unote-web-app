// Account lifecycle: signup (including the seeding it triggers), login, session
// resolution and logout. These go through the real endpoints rather than the fast
// makeUser() helper, because the point is to exercise the password and seeding paths
// that helper deliberately skips.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDatabase, resetData, closeDatabase } from './helpers.js';

const app = buildApp();

const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
});

afterAll(async () => {
  await closeDatabase();
});

describe('POST /api/auth/signup', () => {
  it('creates an account, signs it in, and seeds it a starter notebook', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/signup').send({ email: 'Sam@Example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    // Email is normalised to lower case so 'Sam@' and 'sam@' are one account.
    expect(res.body.user.email).toBe('sam@example.com');
    expect(res.body.user.id).toBeTruthy();

    // seedNewUser ran: the account lands on a usable app, not an empty screen.
    const notebooks = await agent.get('/api/notebooks');
    expect(notebooks.status).toBe(200);
    expect(notebooks.body.notebooks).toHaveLength(1);
    expect(notebooks.body.notebooks[0].name).toBeTruthy();

    // ...and can see the shared built-in templates. The exact set is pinned in
    // templates.test.ts; all this account has to prove is that it gets them at all.
    const templates = await agent.get('/api/templates');
    expect(templates.status).toBe(200);
    expect((templates.body.templates as Array<{ builtin: boolean }>).filter((t) => t.builtin).length).toBeGreaterThan(0);
  });

  it('never stores the password in plaintext', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: 'hash@example.com', password: PASSWORD });
    const row = await db
      .prepare('SELECT password_hash, password_salt FROM users WHERE id = ?')
      .get<{ password_hash: string; password_salt: string }>(res.body.user.id);

    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_hash).not.toContain(PASSWORD);
    expect(row?.password_salt).toBeTruthy();
    // Two accounts with the same password must not share a hash - i.e. the salt is real.
    const other = await request(app).post('/api/auth/signup').send({ email: 'hash2@example.com', password: PASSWORD });
    const otherRow = await db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get<{ password_hash: string }>(other.body.user.id);
    expect(otherRow?.password_hash).not.toBe(row?.password_hash);
  });

  it('gives each new account its own starter notebook, not a shared one', async () => {
    const a = request.agent(app);
    const b = request.agent(app);
    await a.post('/api/auth/signup').send({ email: 'a@example.com', password: PASSWORD });
    await b.post('/api/auth/signup').send({ email: 'b@example.com', password: PASSWORD });

    const aList = await a.get('/api/notebooks');
    const bList = await b.get('/api/notebooks');
    expect(aList.body.notebooks).toHaveLength(1);
    expect(bList.body.notebooks).toHaveLength(1);
    expect(aList.body.notebooks[0].id).not.toBe(bList.body.notebooks[0].id);
  });

  it('rejects a duplicate email with 409, case-insensitively', async () => {
    await request(app).post('/api/auth/signup').send({ email: 'dupe@example.com', password: PASSWORD });
    const again = await request(app).post('/api/auth/signup').send({ email: 'DUPE@example.com', password: PASSWORD });
    expect(again.status).toBe(409);
  });

  it.each([
    ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
    ['a short password', { email: 'short@example.com', password: 'abc' }],
    ['a missing body', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await request(app).post('/api/auth/signup').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// scrypt's first pass is linear in the length of its input and express.json accepts 20mb
// bodies, so an uncapped password field is a CPU amplifier on unauthenticated routes.
// Every route that accepts a password must refuse an over-long one BEFORE it hashes.
describe('password length cap', () => {
  const TOO_LONG = 'x'.repeat(129);

  it('rejects an over-long password at signup', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'long@example.com', password: TOO_LONG });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 128/);
  });

  it('accepts one exactly at the limit', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'atlimit@example.com', password: 'y'.repeat(128) });
    expect(res.status).toBe(201);
  });

  it('rejects an over-long password at login without attempting a hash', async () => {
    await request(app).post('/api/auth/signup').send({ email: 'cap@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'cap@example.com', password: TOO_LONG });
    // 400, not the usual 401 - this is a rejected request shape, not a failed credential.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 128/);
  });

  it('rejects an over-long new password on change and on recovery redemption', async () => {
    const agent = request.agent(app);
    const signup = await agent
      .post('/api/auth/signup')
      .send({ email: 'capchange@example.com', password: PASSWORD });
    const recoveryKey: string = signup.body.recoveryKey;

    const changed = await agent
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: TOO_LONG });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toMatch(/at most 128/);

    const recovered = await request(app)
      .post('/api/auth/recover')
      .send({ email: 'capchange@example.com', recoveryKey, newPassword: TOO_LONG });
    expect(recovered.status).toBe(400);
    expect(recovered.body.error).toMatch(/at most 128/);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/signup').send({ email: 'login@example.com', password: PASSWORD });
  });

  it('signs in with the right password and resolves /me', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email: 'login@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('login@example.com');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('login@example.com');
  });

  it('rejects a wrong password and an unknown email with the same 401 message', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'not the password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical wording, so the response cannot be used to enumerate registered emails.
    expect(unknownEmail.body.error).toBe(wrongPassword.body.error);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalidates the session so protected routes 401 again', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'bye@example.com', password: PASSWORD });
    expect((await agent.get('/api/notebooks')).status).toBe(200);

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(200);

    expect((await agent.get('/api/notebooks')).status).toBe(401);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('POST /api/auth/password', () => {
  it('changes the password, keeps the current session, and drops the old password', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'change@example.com', password: PASSWORD });

    const res = await agent
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(res.status).toBe(200);

    // The caller stays signed in.
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    // The old password no longer works, the new one does.
    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'change@example.com', password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'change@example.com', password: 'a brand new password' });
    expect(newLogin.status).toBe(200);
  });

  it('rejects a wrong current password with 403', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'guard@example.com', password: PASSWORD });

    const res = await agent
      .post('/api/auth/password')
      .send({ currentPassword: 'wrong', newPassword: 'a brand new password' });
    expect(res.status).toBe(403);
  });

  it('401s when not signed in', async () => {
    const res = await request(app)
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(res.status).toBe(401);
  });
});
