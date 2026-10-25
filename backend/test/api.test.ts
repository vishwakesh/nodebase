import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

let app: any;
let db: any;
let cookie = '';
let csrf = '';
let storageRoot = '/tmp/nodebase-test-storage';

before(async () => {
  const configModule = await import('../src/config.js');
  storageRoot = configModule.config.storageRoot;
  await fs.rm(storageRoot, { recursive: true, force: true });
  const server = await import('../src/server.js');
  app = server.app;
  db = (await import('../src/db.js')).db;
  await app.ready();
  const csrfResponse = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
  csrf = csrfResponse.json().csrfToken;
  const setup = await app.inject({
    method: 'POST', url: '/api/auth/setup',
    headers: { 'content-type': 'application/json', cookie: `nb_csrf=${csrf}`, 'x-csrf-token': csrf },
    payload: { setupKey: 'nodebase-test-setup-key', username: 'testadmin', email: 'test@example.test', displayName: 'Test Admin', password: 'test-password-long-123' },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookies = setup.headers['set-cookie'];
  const parts = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean).map((s: string) => s.split(';')[0]);
  cookie = [...parts.filter((s: string) => s.startsWith('nb_session=')), `nb_csrf=${csrf}`].join('; ');
});

after(async () => {
  if (app) await app.close();
  if (db?.open) db.close();
  await fs.rm(storageRoot, { recursive: true, force: true });
});

test('private endpoints require an authenticated session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/files' });
  assert.equal(res.statusCode, 401);
});

test('mutating requests require a matching CSRF token', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/files/folders', headers: { cookie, 'content-type': 'application/json' }, payload: { name: 'Nope', parentId: null } });
  assert.equal(res.statusCode, 403);
});

test('bot environment values are encrypted and never returned by the listing API', async () => {
  const created = await app.inject({ method:'POST', url:'/api/bots', headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'}, payload:{name:'Secret Test Bot',runtime:'python',entrypoint:'main.py'} });
  assert.equal(created.statusCode,201,created.body);
  const botId = created.json().bot.id;
  const secret = 'top-secret-discord-token-should-not-appear';
  const saved = await app.inject({ method:'PUT',url:`/api/bots/${botId}/environment`,headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},payload:{set:[{key:'DISCORD_TOKEN',value:secret}],remove:[]} });
  assert.equal(saved.statusCode,200,saved.body);
  const list = await app.inject({method:'GET',url:`/api/bots/${botId}/environment`,headers:{cookie}});
  assert.equal(list.statusCode,200);
  assert.equal(list.body.includes(secret),false);
  assert.deepEqual(list.json().variables.map((v:any)=>v.key),['DISCORD_TOKEN']);
  const stored = db.prepare('SELECT encrypted_value FROM bot_env WHERE bot_id=?').get(botId).encrypted_value;
  assert.equal(stored.includes(secret),false);
});

test('uploaded files stay private and can be downloaded through an authorized route', async () => {
  const boundary='nodebase-test-boundary';
  const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nhello nodebase\r\n--${boundary}--\r\n`);
  const uploaded=await app.inject({method:'POST',url:'/api/files/upload',headers:{cookie,'x-csrf-token':csrf,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
  assert.equal(uploaded.statusCode,201,uploaded.body);
  const file=uploaded.json().file;
  const downloaded=await app.inject({method:'GET',url:`/api/files/${file.id}/download`,headers:{cookie}});
  assert.equal(downloaded.statusCode,200);
  assert.equal(downloaded.body,'hello nodebase');
  const unauthenticated=await app.inject({method:'GET',url:`/api/files/${file.id}/download`});
  assert.equal(unauthenticated.statusCode,401);
  const blob=db.prepare('SELECT blob_name FROM files WHERE id=?').get(file.id).blob_name;
  assert.ok((await fs.stat(path.join(storageRoot,'file-blobs',blob))).size>0);
});

test('database schema is tracked through a versioned migration', () => {
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row: any) => row.version);
  assert.deepEqual(applied, ['001_initial.sql']);
});
