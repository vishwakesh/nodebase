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
  assert.deepEqual(applied, ['001_initial.sql', '002_nodes.sql']);
});


test('node enrollment tokens are single-use and agent heartbeats update real node telemetry', async () => {
  const tokenRes = await app.inject({
    method: 'POST', url: '/api/nodes/enrollment-tokens',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { label: 'Test remote node' },
  });
  assert.equal(tokenRes.statusCode, 201, tokenRes.body);
  const enrollmentToken = tokenRes.json().token;
  assert.equal(typeof enrollmentToken, 'string');
  assert.ok(enrollmentToken.length >= 32);

  const enrolled = await app.inject({
    method: 'POST', url: '/api/agent/enroll',
    headers: { authorization: `Bearer ${enrollmentToken}`, 'content-type': 'application/json' },
    payload: { name: 'Test node', region: 'Test region', agentVersion: 'test-1', runtimes: ['python', 'node'], cpuCores: 4, memoryTotalBytes: 8_000_000_000, storageTotalBytes: 100_000_000_000 },
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const node = enrolled.json().node;
  const nodeToken = enrolled.json().nodeToken;
  assert.equal(node.name, 'Test node');
  assert.equal(node.status, 'offline', 'enrollment is not treated as a heartbeat');
  assert.ok(nodeToken.length >= 32);

  const replay = await app.inject({
    method: 'POST', url: '/api/agent/enroll',
    headers: { authorization: `Bearer ${enrollmentToken}`, 'content-type': 'application/json' },
    payload: { name: 'Replay node', region: '', agentVersion: 'test-1', runtimes: ['node'] },
  });
  assert.equal(replay.statusCode, 401);

  const heartbeat = await app.inject({
    method: 'POST', url: '/api/agent/heartbeat',
    headers: { authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json' },
    payload: { agentVersion: 'test-1', cpuPercent: 23, memoryTotalBytes: 8_000_000_000, memoryUsedBytes: 2_000_000_000, storageTotalBytes: 100_000_000_000, storageUsedBytes: 40_000_000_000, workloadCount: 2, runtimes: ['python', 'node'] },
  });
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);

  const listed = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  const found = listed.json().nodes.find((n: any) => n.id === node.id);
  assert.equal(found.status, 'online');
  assert.equal(found.cpuPercent, 23);
  assert.equal(found.workloadCount, 2);
  assert.equal(listed.body.includes(nodeToken), false);

  const unauthenticated = await app.inject({
    method: 'POST', url: '/api/agent/heartbeat',
    headers: { 'content-type': 'application/json' },
    payload: { agentVersion: 'test-1', cpuPercent: 0, memoryTotalBytes: 1, memoryUsedBytes: 0, storageTotalBytes: 1, storageUsedBytes: 0, workloadCount: 0, runtimes: ['node'] },
  });
  assert.equal(unauthenticated.statusCode, 401);

  db.prepare('UPDATE nodes SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now() - 120_000).toISOString(), node.id);
  const stale = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
  assert.equal(stale.json().nodes.find((n: any) => n.id === node.id).status, 'offline');

  const revoked = await app.inject({ method: 'DELETE', url: `/api/nodes/${node.id}`, headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(revoked.statusCode, 204);
  const revokedHeartbeat = await app.inject({
    method: 'POST', url: '/api/agent/heartbeat',
    headers: { authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json' },
    payload: { agentVersion: 'test-1', cpuPercent: 0, memoryTotalBytes: 1, memoryUsedBytes: 0, storageTotalBytes: 1, storageUsedBytes: 0, runtimes: ['node'] },
  });
  assert.equal(revokedHeartbeat.statusCode, 401);
});
