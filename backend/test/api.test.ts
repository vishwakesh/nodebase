import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

let app: any;
let db: any;
let cookie = '';
let csrf = '';
let storageRoot = '/tmp/nodebase-test-storage';
let blobRoot = '/tmp/nodebase-test-storage/file-blobs';

before(async () => {
  const configModule = await import('../src/config.js');
  storageRoot = configModule.config.storageRoot;
  blobRoot = configModule.config.blobRoot;
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
  assert.deepEqual(applied, ['001_initial.sql', '002_nodes.sql', '003_watch.sql']);
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

  const drained = await app.inject({
    method: 'POST', url: `/api/nodes/${node.id}/drain`,
    headers: { cookie, 'x-csrf-token': csrf }, payload: {},
  });
  assert.equal(drained.statusCode, 200);
  const heartbeatWhileDraining = await app.inject({
    method: 'POST', url: '/api/agent/heartbeat',
    headers: { authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json' },
    payload: { agentVersion: 'test-1', cpuPercent: 24, memoryTotalBytes: 8_000_000_000, memoryUsedBytes: 2_100_000_000, storageTotalBytes: 100_000_000_000, storageUsedBytes: 40_000_000_000, workloadCount: 2, runtimes: ['python', 'node'] },
  });
  assert.equal(heartbeatWhileDraining.statusCode, 200);
  const drainingList = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
  assert.equal(drainingList.json().nodes.find((n: any) => n.id === node.id).status, 'draining');

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


test('WATCH creates private rooms, issues scoped invitations, joins guests, and streams byte ranges', async () => {
  const { randomUUID } = await import('node:crypto');
  const fileId = randomUUID();
  const blobName = randomUUID();
  const media = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await fs.mkdir(blobRoot, { recursive: true });
  await fs.writeFile(path.join(blobRoot, blobName), media);
  db.prepare('INSERT INTO files (id,name,folder_id,blob_name,size,mime_type,created_at,updated_at) VALUES (?,?,NULL,?,?,?,?,?)')
    .run(fileId, 'watch-sample.mp4', blobName, media.length, 'video/mp4', new Date().toISOString(), new Date().toISOString());

  const created = await app.inject({
    method: 'POST', url: '/api/watch/rooms',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { title: 'Private test room', videoFileId: fileId, visibility: 'discoverable_private', participantLimit: 4 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id;
  assert.equal(created.json().video.delivery, 'progressive');
  assert.equal(created.json().room.visibility, 'discoverable_private');

  const invitation = await app.inject({
    method: 'POST', url: `/api/watch/rooms/${roomId}/invitations`,
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { expiresInHours: 1, maxUses: 1 },
  });
  assert.equal(invitation.statusCode, 201, invitation.body);
  const token = invitation.json().invitation.token;
  assert.ok(token.length >= 40);
  assert.equal(invitation.body.includes(token), true, 'raw token is returned once to the creator');
  const stored = (db.prepare('SELECT token_hash FROM watch_invitations WHERE id=?').get(invitation.json().invitation.id) as any).token_hash;
  assert.notEqual(stored, token, 'only token hash is persisted');
  const unauthenticatedRevoke = await app.inject({ method: 'DELETE', url: `/api/watch/invitations/${invitation.json().invitation.id}`, headers: { cookie: `nb_csrf=${csrf}`, 'x-csrf-token': csrf } });
  assert.equal(unauthenticatedRevoke.statusCode, 401, 'invitation revocation requires an authenticated room owner');

  const preview = await app.inject({ method: 'POST', url: '/api/watch/invitations/resolve', headers: { cookie: `nb_csrf=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: { token } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().room.title, 'Private test room');

  const joinAttempts = await Promise.all([1, 2].map((n) => app.inject({
    method: 'POST', url: '/api/watch/invitations/join',
    headers: { cookie: `nb_csrf=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { token, displayName: `Guest Viewer ${n}` },
  })));
  const joined = joinAttempts.find((attempt: any) => attempt.statusCode === 201);
  const rejectedJoin = joinAttempts.find((attempt: any) => attempt.statusCode !== 201);
  assert.ok(joined, 'one concurrent join consumes the one-use invitation');
  assert.equal(rejectedJoin?.statusCode, 404, 'the competing join cannot exceed max uses');
  assert.equal(joined.json().status, 'joined');
  const setCookies = joined.headers['set-cookie'];
  const cookieValues = (Array.isArray(setCookies) ? setCookies : [setCookies]).filter(Boolean).map((value: string) => value.split(';')[0]);
  const watchCookie = cookieValues.find((value: string) => value.startsWith('nb_watch_'));
  assert.ok(watchCookie, 'guest receives a room-scoped HttpOnly cookie');
  const guestCookie = `${cookie}; ${watchCookie}`;

  const guestRoom = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}`, headers: { cookie: guestCookie } });
  assert.equal(guestRoom.statusCode, 200, guestRoom.body);
  assert.match(guestRoom.json().participant.displayName, /^Guest Viewer [12]$/);

  const hostPlayback = await app.inject({
    method: 'POST', url: `/api/watch/rooms/${roomId}/playback`,
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { action: 'play', positionMs: 12500 },
  });
  assert.equal(hostPlayback.statusCode, 200, hostPlayback.body);
  assert.equal(hostPlayback.json().playback.state, 'playing');

  const guestPlayback = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}/playback`, headers: { cookie: guestCookie } });
  assert.equal(guestPlayback.statusCode, 200, guestPlayback.body);
  assert.equal(guestPlayback.json().playback.state, 'playing');
  const guestCannotControl = await app.inject({
    method: 'POST', url: `/api/watch/guest/${roomId}/playback`,
    headers: { cookie: guestCookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    payload: { action: 'pause', positionMs: 12500 },
  });
  assert.equal(guestCannotControl.statusCode, 403, 'ordinary guests cannot change the host-controlled timeline');

  const mediaRange = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}/media`, headers: { cookie: guestCookie, range: 'bytes=0-4' } });
  assert.equal(mediaRange.statusCode, 206, mediaRange.body);
  assert.equal(mediaRange.body, '01234');
  assert.equal(mediaRange.headers['content-range'], `bytes 0-4/${media.length}`);
  const invalidRange = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}/media`, headers: { cookie: guestCookie, range: 'bytes=-0' } });
  assert.equal(invalidRange.statusCode, 416, 'zero-length suffix ranges are rejected');

  const unauthenticatedMedia = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}/media` });
  assert.equal(unauthenticatedMedia.statusCode, 401);

  const replay = await app.inject({ method: 'POST', url: '/api/watch/invitations/resolve', headers: { cookie: `nb_csrf=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: { token } });
  assert.equal(replay.statusCode, 404, 'single-use invitation is no longer valid');
  const leave = await app.inject({ method: 'POST', url: `/api/watch/guest/${roomId}/leave`, headers: { cookie: guestCookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {} });
  assert.equal(leave.statusCode, 200);
  const afterLeave = await app.inject({ method: 'GET', url: `/api/watch/guest/${roomId}`, headers: { cookie: guestCookie } });
  assert.equal(afterLeave.statusCode, 401, 'leaving revokes the room-scoped guest session');
});

test('WATCH discovery lists only other hosts’ discoverable-private rooms', async () => {
  const { randomUUID } = await import('node:crypto');
  const otherOwnerId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin (id,username,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(otherOwnerId, 'watchhost', 'watchhost@example.test', 'Watch Host', 'unused-test-hash', now);
  const video = db.prepare(`SELECT id FROM files WHERE mime_type='video/mp4' ORDER BY created_at DESC LIMIT 1`).get() as any;
  assert.ok(video, 'WATCH test video exists');

  const discoverableId = randomUUID();
  db.prepare(`INSERT INTO watch_rooms (id,owner_id,title,description,category,visibility,status,current_video_file_id,participant_limit,approval_required,chat_enabled,viewer_control_enabled,playback_state,playback_position_ms,playback_rate,playback_sequence,playback_updated_at,created_at,updated_at) VALUES (?,?,?,'','General','discoverable_private','waiting',?,12,1,1,0,'paused',0,1,0,?,?,?)`)
    .run(discoverableId, otherOwnerId, 'Discoverable test room', video.id, now, now, now);
  db.prepare(`INSERT INTO watch_participants (id,room_id,user_id,display_name,role,status,joined_at,last_seen_at) VALUES (?,?,?,'Watch Host','host','joined',?,?)`)
    .run(randomUUID(), discoverableId, otherOwnerId, now, now);

  const privateId = randomUUID();
  db.prepare(`INSERT INTO watch_rooms (id,owner_id,title,description,category,visibility,status,current_video_file_id,participant_limit,approval_required,chat_enabled,viewer_control_enabled,playback_state,playback_position_ms,playback_rate,playback_sequence,playback_updated_at,created_at,updated_at) VALUES (?,?,?,'','General','private','waiting',?,12,0,1,0,'paused',0,1,0,?,?,?)`)
    .run(privateId, otherOwnerId, 'Private hidden room', video.id, now, now, now);

  const listed = await app.inject({ method: 'GET', url: '/api/watch/discovery', headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(listed.json().rooms.some((room: any) => room.id === discoverableId));
  assert.ok(!listed.json().rooms.some((room: any) => room.id === privateId));
  assert.ok(!listed.json().rooms.some((room: any) => room.title === 'Private test room'), 'the current owner does not see its own room in discovery');
  assert.ok(listed.json().rooms.every((room: any) => !('invitationToken' in room) && !('videoPath' in room) && !('filePath' in room)));
});
