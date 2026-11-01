import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import mime from 'mime-types';
import { z } from 'zod';
import { config } from './config.js';
import { db, nowIso, addActivity } from './db.js';
import { randomToken, sha256, safeEqual, hashPassword, verifyPassword, encryptSecret, decryptSecret, safeFilename, validEnvKey, validEntryPoint, resolveInside, isSafeSetupKey, securityCookieOptions, SESSION_COOKIE, CSRF_COOKIE } from './security.js';
import { blobPath, backupPath, diskAvailableBytes, folderSize, safeExtractZip, createWorkspaceZip, copyTree, newBlobName } from './storage.js';
import { getRunnerHealth, runner, RunnerUnavailableError } from './runner-client.js';

if (config.nodeEnv === 'production') {
  const invalid: string[] = [];
  if (config.setupKey.length < 32 || /^replace[-_]/i.test(config.setupKey)) invalid.push('NODEBASE_SETUP_KEY (use at least 32 random characters)');
  if (!config.encryptionKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(config.encryptionKey) || Buffer.from(config.encryptionKey, 'base64').length !== 32) invalid.push('NODEBASE_ENCRYPTION_KEY (base64-encoded 32-byte key required)');
  if (config.runnerToken && (config.runnerToken.length < 32 || /^replace[-_]/i.test(config.runnerToken))) invalid.push('RUNNER_TOKEN (use at least 32 random characters)');
  if (invalid.length) throw new Error(`Unsafe NODEBASE production configuration: ${invalid.join(', ')}.`);
}

interface Admin { id: string; username: string; email: string; display_name: string; }
declare module 'fastify' {
  interface FastifyRequest { admin: Admin | null; sessionId: string | null; }
}
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 2 * 1024 * 1024, trustProxy: process.env.TRUST_PROXY === 'true', requestIdHeader: 'x-request-id', genReqId: () => randomUUID() });
app.decorateRequest('admin', null);
app.decorateRequest('sessionId', null);

await app.register(cookie);
await app.register(helmet, { contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"],
  connectSrc: ["'self'", 'ws:', 'wss:'], upgradeInsecureRequests: config.nodeEnv === 'production' ? [] : null,
} } });
await app.register(cors, {
  credentials: true,
  origin(origin, callback) {
    const allowed = new Set([config.frontendOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173'].filter(Boolean));
    if (!origin || allowed.has(origin)) callback(null, true); else callback(new Error('Origin is not allowed by CORS.'), false);
  },
});
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(multipart, { limits: { files: 1, fields: 12, parts: 16, fileSize: Math.max(config.maxFileBytes, config.maxBotUploadBytes) } });

const publicPaths = new Set(['/api/health', '/api/auth/csrf', '/api/auth/setup-status', '/api/auth/setup', '/api/auth/login']);
function requestPath(request: FastifyRequest) { return request.url.split('?')[0]; }
function csrfOk(request: FastifyRequest) {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers['x-csrf-token'];
  return typeof cookieToken === 'string' && typeof headerToken === 'string' && safeEqual(cookieToken, headerToken);
}
app.addHook('onRequest', async (request, reply) => {
  const pathname = requestPath(request);
  if (!pathname.startsWith('/api/')) return;
  if (pathname.startsWith('/api/agent/')) return; // Agent routes authenticate with per-node bearer credentials.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !csrfOk(request)) {
    return reply.code(403).send({ error: { code: 'CSRF_INVALID', message: 'Security token missing or expired. Refresh the page and try again.' } });
  }
  if (publicPaths.has(pathname) || pathname === '/api/watch/invitations/resolve' || pathname === '/api/watch/invitations/join' || pathname.startsWith('/api/watch/guest/') || request.method === 'OPTIONS') return;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' } });
  const session = db.prepare(`SELECT s.id as session_id, s.expires_at, a.id, a.username, a.email, a.display_name
    FROM sessions s JOIN admin a ON a.id=s.user_id WHERE s.token_hash=?`).get(sha256(token)) as (Admin & { session_id: string; expires_at: string }) | undefined;
  if (!session || session.expires_at <= nowIso()) {
    if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session.session_id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(401).send({ error: { code: 'SESSION_EXPIRED', message: 'Your session expired. Please sign in again.' } });
  }
  request.admin = { id: session.id, username: session.username, email: session.email, display_name: session.display_name };
  request.sessionId = session.session_id;
});

app.setErrorHandler((error, request, reply) => {
  if ((error as any).validation) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } });
  if ((error as any).statusCode === 413 || error.message?.toLowerCase().includes('file too large')) return reply.code(413).send({ error: { code: 'UPLOAD_TOO_LARGE', message: 'The upload exceeds the configured file-size limit.' } });
  request.log.error({ err: error, requestId: request.id }, 'Request failed');
  const status = Number((error as any).statusCode) >= 400 && Number((error as any).statusCode) < 600 ? Number((error as any).statusCode) : 500;
  const safeMessage = status >= 500 ? 'The server could not complete this request.' : error.message;
  return reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: safeMessage, requestId: request.id } });
});

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')), { statusCode: 400 });
  return parsed.data;
}
function notFound(message: string) { return Object.assign(new Error(message), { statusCode: 404 }); }
function conflict(message: string) { return Object.assign(new Error(message), { statusCode: 409 }); }
function badRequest(message: string) { return Object.assign(new Error(message), { statusCode: 400 }); }
function forbidden(message: string) { return Object.assign(new Error(message), { statusCode: 403 }); }
function requireBot(botId: string) {
  const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
  if (!bot) throw notFound('Bot not found.');
  return bot;
}
function requireFolder(folderId: string | null | undefined) {
  if (!folderId) return null;
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(folderId) as any;
  if (!folder) throw notFound('Folder not found.');
  return folder;
}
function safeStatMetrics() {
  let disk: any = null;
  try { const s = fs.statfsSync(config.storageRoot); const total = Number(s.blocks) * Number(s.bsize); const free = Number(s.bavail) * Number(s.bsize); disk = { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free), percent: total ? Math.round((total - free) / total * 100) : null }; } catch { /* actual unavailable */ }
  let totalMem = os.totalmem(); let freeMem = os.freemem();
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(); const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    if (max !== 'max' && Number(max) > 0) { totalMem = Number(max); freeMem = Math.max(0, totalMem - current); }
  } catch { /* cgroup v1 or host runtime */ }
  const memory = { totalBytes: totalMem, freeBytes: freeMem, usedBytes: Math.max(0, totalMem - freeMem), percent: totalMem ? Math.round((totalMem - freeMem) / totalMem * 100) : null };
  let cpuPercent: number | null = null;
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = values[3] + (values[4] ?? 0); const total = values.reduce((sum, n) => sum + n, 0);
    const previous = (globalThis as any).__nbCpu as { idle: number; total: number } | undefined;
    (globalThis as any).__nbCpu = { idle, total };
    if (previous && total > previous.total) cpuPercent = Math.round((1 - (idle - previous.idle) / (total - previous.total)) * 100);
  } catch { /* actual unavailable */ }
  return { cpuPercent, memory, disk };
}
const toHuman = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

app.get('/api/health', async () => {
  let database = false;
  try { database = db.prepare('SELECT 1 AS ok').get() != null; } catch {}
  const runnerHealth = await getRunnerHealth();
  return { ok: database, database, runner: runnerHealth.connected, runnerMessage: runnerHealth.message, uptimeSeconds: Math.floor(process.uptime()), time: nowIso() };
});
app.get('/api/auth/csrf', async (_request, reply) => {
  const token = randomToken();
  reply.setCookie(CSRF_COOKIE, token, { httpOnly: false, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 });
  return { csrfToken: token };
});
app.get('/api/auth/setup-status', async () => ({ setupRequired: (db.prepare('SELECT COUNT(*) AS c FROM admin').get() as any).c === 0, setupKeyConfigured: Boolean(config.setupKey) }));
const setupSchema = z.object({ setupKey: z.string().min(1), username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/), email: z.string().email().max(254), displayName: z.string().min(1).max(80), password: z.string().min(12).max(128) });
app.post('/api/auth/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = parseBody(setupSchema, request.body);
  if (!isSafeSetupKey(body.setupKey)) throw forbidden('The one-time setup key is incorrect. Configure NODEBASE_SETUP_KEY on the server.');
  if ((db.prepare('SELECT COUNT(*) AS c FROM admin').get() as any).c > 0) throw conflict('Initial setup has already been completed.');
  const passwordHash = await hashPassword(body.password); const id = randomUUID(); const now = nowIso();
  try {
    const createAdmin = db.transaction(() => {
      if ((db.prepare('SELECT COUNT(*) AS c FROM admin').get() as any).c > 0) throw conflict('Initial setup has already been completed.');
      db.prepare('INSERT INTO admin (id,username,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, body.username, body.email, body.displayName, passwordHash, now);
    });
    createAdmin();
  } catch (error) {
    if ((error as any)?.statusCode === 409) throw error;
    throw conflict('That username or email is already in use.');
  }
  createSession(request, reply, id);
  addActivity('security', 'NODEBASE administrator created', { username: body.username });
  return { user: { id, username: body.username, email: body.email, displayName: body.displayName } };
});
function createSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken(); const id = randomUUID(); const csrf = request.cookies[CSRF_COOKIE] ?? randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (id,token_hash,csrf_token,user_id,expires_at,created_at,user_agent,ip) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, sha256(token), csrf, userId, expires, nowIso(), String(request.headers['user-agent'] ?? '').slice(0, 500), request.ip);
  reply.setCookie(SESSION_COOKIE, token, { ...securityCookieOptions(), expires: new Date(expires) });
  if (!request.cookies[CSRF_COOKIE]) reply.setCookie(CSRF_COOKIE, csrf, { httpOnly: false, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 });
}
app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = parseBody(z.object({ username: z.string().min(1).max(254), password: z.string().min(1).max(128) }), request.body);
  const admin = db.prepare('SELECT * FROM admin WHERE username=? OR email=?').get(body.username, body.username) as any;
  const ok = admin ? await verifyPassword(body.password, admin.password_hash) : await verifyPassword(body.password, 'scrypt$MDEyMzQ1Njc4OWFiY2RlZg==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');
  if (!admin || !ok) throw Object.assign(new Error('Invalid username/email or password.'), { statusCode: 401 });
  createSession(request, reply, admin.id);
  addActivity('security', 'Administrator signed in', { username: admin.username });
  return { user: { id: admin.id, username: admin.username, email: admin.email, displayName: admin.display_name } };
});
app.get('/api/auth/session', async (request) => ({ user: request.admin ? { id: request.admin.id, username: request.admin.username, email: request.admin.email, displayName: request.admin.display_name } : null }));
app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies[SESSION_COOKIE]; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' }); addActivity('security', 'Administrator signed out'); return { ok: true };
});
app.get('/api/auth/sessions', async (request) => ({ sessions: db.prepare('SELECT id,created_at,expires_at,user_agent,ip FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(request.admin!.id).map((s: any) => ({ ...s, current: s.id === request.sessionId })) }));
app.delete('/api/auth/sessions/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (id === request.sessionId) throw badRequest('Use the sign-out action to end your current session.');
  db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(id, request.admin!.id); return reply.code(204).send();
});

app.get('/api/dashboard', async () => {
  let bots = db.prepare('SELECT id,name,runtime,status,container_id,created_at,updated_at,last_deployed_at,last_error FROM bots ORDER BY updated_at DESC').all() as any[];
  const runnerHealth = await getRunnerHealth();
  if (runnerHealth.connected && bots.length) {
    await Promise.all(bots.map(async bot => {
      try {
        const live = await runner.status(bot.id);
        bot.status = live.status;
        bot.last_error = live.lastError ?? bot.last_error;
        db.prepare('UPDATE bots SET status=?,last_error=?,updated_at=? WHERE id=?').run(bot.status, bot.last_error, nowIso(), bot.id);
      } catch { /* show last known state when an individual status request fails */ }
    }));
  } else if (!runnerHealth.connected) {
    bots = bots.map(bot => ({ ...bot, status: bot.container_id ? 'runner-unavailable' : bot.status }));
  }
  const cloud = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS files FROM files').get() as any;
  const recentFiles = db.prepare('SELECT id,name,size,mime_type,created_at,folder_id FROM files ORDER BY created_at DESC LIMIT 5').all();
  const activity = db.prepare('SELECT id,type,message,created_at FROM activity ORDER BY created_at DESC LIMIT 8').all();
  const metrics = safeStatMetrics();
  const statusCounts = { running: bots.filter(b => b.status === 'running').length, stopped: bots.filter(b => b.status === 'stopped').length, crashed: bots.filter(b => b.status === 'crashed').length };
  return { bots: { total: bots.length, ...statusCounts }, resources: metrics, storage: { usedBytes: cloud.bytes, fileCount: cloud.files, limitBytes: config.maxStorageBytes, percent: Math.min(100, Math.round(cloud.bytes / config.maxStorageBytes * 100)) }, runner: runnerHealth, recentBots: bots.slice(0, 5).map(({ container_id, ...bot }) => bot), recentFiles, activity };
});

// Multi-node control plane foundation. The agent initiates outbound HTTPS requests; no node management port is exposed.
const enrollmentSchema = z.object({ label: z.string().trim().min(2).max(80).default('Hosting node') });
const enrollAgentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).default(''),
  agentVersion: z.string().trim().min(1).max(40).default('unknown'),
  runtimes: z.array(z.enum(['python','node'])).min(1).max(2).default(['python','node']),
  cpuCores: z.number().int().min(0).max(4096).default(0),
  memoryTotalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  storageTotalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
const heartbeatSchema = z.object({
  agentVersion: z.string().trim().min(1).max(40),
  cpuPercent: z.number().min(0).max(100).nullable().optional(),
  memoryTotalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  memoryUsedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  storageTotalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  storageUsedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  workloadCount: z.number().int().min(0).max(100000).nullable().optional(),
  runtimes: z.array(z.enum(['python','node'])).min(1).max(2),
});
function bearerValue(request: FastifyRequest) {
  const value = request.headers.authorization ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(value);
  return match?.[1] ?? '';
}
function agentNode(request: FastifyRequest) {
  const token = bearerValue(request);
  if (!token) throw Object.assign(new Error('Node credential is missing.'), { statusCode: 401 });
  const node = db.prepare('SELECT * FROM nodes WHERE token_hash=?').get(sha256(token)) as any;
  if (!node || node.status === 'revoked' || !node.token_hash) throw Object.assign(new Error('Node credential is invalid or revoked.'), { statusCode: 401 });
  return node;
}
function nodeView(row: any) {
  const lastHeartbeat = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0;
  const fresh = lastHeartbeat > 0 && Date.now() - lastHeartbeat <= 90_000;
  // Heartbeat freshness takes precedence over last-known scheduler state.
  let status = row.status === 'revoked' ? 'revoked' : !fresh ? 'offline' : row.status === 'draining' ? 'draining' : row.status === 'unhealthy' ? 'unhealthy' : 'online';
  return {
    id: row.id, name: row.name, region: row.region, agentVersion: row.agent_version,
    runtimes: JSON.parse(row.runtimes_json || '["python","node"]'), cpuCores: row.cpu_cores,
    cpuPercent: row.cpu_percent, memoryTotalBytes: row.memory_total_bytes, memoryUsedBytes: row.memory_used_bytes,
    storageTotalBytes: row.storage_total_bytes, storageUsedBytes: row.storage_used_bytes,
    workloadCount: row.workload_count, status, tokenSuffix: row.token_suffix,
    lastHeartbeatAt: row.last_heartbeat_at, createdAt: row.created_at, updatedAt: row.updated_at,
    heartbeatAgeSeconds: lastHeartbeat ? Math.max(0, Math.floor((Date.now() - lastHeartbeat) / 1000)) : null,
  };
}
app.get('/api/nodes', async () => {
  const rows = db.prepare(`SELECT * FROM nodes WHERE status <> 'revoked' ORDER BY created_at DESC`).all() as any[];
  const nodes = rows.map(nodeView);
  return { nodes, summary: { total: nodes.length, online: nodes.filter(n => n.status === 'online').length, offline: nodes.filter(n => n.status === 'offline').length, unhealthy: nodes.filter(n => n.status === 'unhealthy').length, draining: nodes.filter(n => n.status === 'draining').length } };
});
app.post('/api/nodes/enrollment-tokens', async (request, reply) => {
  const body = parseBody(enrollmentSchema, request.body ?? {});
  const id = randomUUID(); const token = randomToken(32); const now = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  db.prepare('INSERT INTO node_enrollment_tokens (id,label,token_hash,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, body.label, sha256(token), request.admin!.id, expiresAt, now);
  addActivity('node', 'Created a short-lived node enrollment token', { label: body.label, expiresAt });
  return reply.code(201).send({ token, expiresAt, label: body.label, note: 'This token is shown once. Keep it private and use it within 15 minutes.' });
});
app.post('/api/agent/enroll', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = parseBody(enrollAgentSchema, request.body);
  const provided = bearerValue(request);
  if (!provided) throw Object.assign(new Error('Enrollment token is required.'), { statusCode: 401 });
  const enrollment = db.prepare('SELECT * FROM node_enrollment_tokens WHERE token_hash=?').get(sha256(provided)) as any;
  const now = nowIso();
  if (!enrollment || enrollment.used_at || enrollment.expires_at <= now) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used.'), { statusCode: 401 });
  const id = randomUUID(); const nodeToken = randomToken(32);
  const createNode = db.transaction(() => {
    const claimed = db.prepare('UPDATE node_enrollment_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(now, enrollment.id, now);
    if (claimed.changes !== 1) throw Object.assign(new Error('Enrollment token has already been used.'), { statusCode: 409 });
    db.prepare(`INSERT INTO nodes (id,name,region,agent_version,runtimes_json,cpu_cores,memory_total_bytes,storage_total_bytes,status,token_hash,token_suffix,last_heartbeat_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.name, body.region, body.agentVersion, JSON.stringify(body.runtimes), body.cpuCores, body.memoryTotalBytes, body.storageTotalBytes, 'offline', sha256(nodeToken), nodeToken.slice(-6), null, now, now);
  });
  createNode();
  addActivity('node', `Hosting node enrolled: ${body.name}`, { nodeId: id, region: body.region });
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as any;
  return reply.code(201).send({ node: nodeView(node), nodeToken, heartbeatIntervalSeconds: 30 });
});
app.post('/api/agent/heartbeat', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
  const node = agentNode(request);
  const body = parseBody(heartbeatSchema, request.body);
  const now = nowIso();
  const tokenHash = sha256(bearerValue(request));
  // Compare the credential again in the UPDATE. This closes a race where an
  // in-flight heartbeat could otherwise restore a node after an admin revoked it.
  // Keep a concurrent drain operation intact as well.
  const updated = db.prepare(`UPDATE nodes SET agent_version=?,runtimes_json=?,cpu_percent=?,memory_total_bytes=?,memory_used_bytes=?,storage_total_bytes=?,storage_used_bytes=?,workload_count=?,status=CASE WHEN status='draining' THEN 'draining' ELSE 'online' END,last_heartbeat_at=?,last_error=NULL,updated_at=? WHERE id=? AND token_hash=? AND status<>'revoked'`)
    .run(body.agentVersion, JSON.stringify(body.runtimes), body.cpuPercent ?? null, body.memoryTotalBytes, Math.min(body.memoryUsedBytes, body.memoryTotalBytes), body.storageTotalBytes, Math.min(body.storageUsedBytes, body.storageTotalBytes), body.workloadCount ?? null, now, now, node.id, tokenHash);
  if (updated.changes !== 1) throw Object.assign(new Error('Node credential is invalid or revoked.'), { statusCode: 401 });
  return { ok: true, serverTime: now, nextHeartbeatSeconds: 30 };
});
app.get('/api/nodes/:id', async (request) => {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT * FROM nodes WHERE id=? AND status <> \'revoked\'').get(id) as any;
  if (!row) throw notFound('Node not found.');
  return { node: nodeView(row) };
});
app.post('/api/nodes/:id/drain', async (request) => {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT id,name,status FROM nodes WHERE id=? AND status <> \'revoked\'').get(id) as any;
  if (!row) throw notFound('Node not found.');
  db.prepare("UPDATE nodes SET status='draining',updated_at=? WHERE id=?").run(nowIso(), id);
  addActivity('node', `Node marked draining: ${row.name}`, { nodeId: id });
  return { ok: true };
});
app.post('/api/nodes/:id/accept-workloads', async (request) => {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT id,name,last_heartbeat_at FROM nodes WHERE id=? AND status <> \'revoked\'').get(id) as any;
  if (!row) throw notFound('Node not found.');
  if (!row.last_heartbeat_at || Date.now() - new Date(row.last_heartbeat_at).getTime() > 90_000) throw conflict('Node has not sent a recent heartbeat; it cannot accept workloads yet.');
  db.prepare("UPDATE nodes SET status='online',updated_at=? WHERE id=?").run(nowIso(), id);
  addActivity('node', `Node accepting workloads: ${row.name}`, { nodeId: id });
  return { ok: true };
});
app.delete('/api/nodes/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT id,name FROM nodes WHERE id=? AND status <> \'revoked\'').get(id) as any;
  if (!row) throw notFound('Node not found.');
  // Revocation invalidates its credential without making claims about the workload state on the host.
  db.prepare("UPDATE nodes SET status='revoked',token_hash=NULL,token_suffix=NULL,last_error='Credential revoked',updated_at=? WHERE id=?").run(nowIso(), id);
  addActivity('security', `Node credential revoked: ${row.name}`, { nodeId: id });
  return reply.code(204).send();
});

// Bots — lifecycle operations are delegated to the separately authenticated runner.
app.get('/api/bots', async () => {
  const bots = db.prepare('SELECT * FROM bots ORDER BY updated_at DESC').all() as any[];
  const health = await getRunnerHealth();
  if (health.connected) {
    await Promise.all(bots.map(async bot => {
      try { const result = await runner.status(bot.id); bot.status = result.status; bot.last_error = result.lastError ?? bot.last_error; db.prepare('UPDATE bots SET status=?,last_error=?,updated_at=? WHERE id=?').run(bot.status, bot.last_error, nowIso(), bot.id); }
      catch { bot.status = 'runner-unavailable'; }
    }));
  } else if (bots.length) bots.forEach(bot => { bot.status = bot.container_id ? 'runner-unavailable' : 'stopped'; });
  return { bots: bots.map(({ container_id, ...bot }) => ({ ...bot, installDeps: Boolean(bot.install_deps), restartOnFailure: Boolean(bot.restart_on_failure), runnerConnected: health.connected })) , runner: health };
});
app.post('/api/bots', async (request, reply) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(80), runtime: z.enum(['python','node']), entrypoint: z.string().max(240).optional() }), request.body);
  const entrypoint = body.entrypoint ?? (body.runtime === 'python' ? 'main.py' : 'index.js');
  if (!validEntryPoint(entrypoint)) throw badRequest('Entry point must be a relative file path inside the bot project.');
  const id = randomUUID(); const now = nowIso();
  const projectDir = path.join(config.botRoot, id, 'project'); await fsp.mkdir(projectDir, { recursive: true, mode: 0o750 });
  db.prepare('INSERT INTO bots (id,name,runtime,entrypoint,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, body.name, body.runtime, entrypoint, 'stopped', now, now);
  addActivity('bot', `Created bot project ${body.name}`, { botId: id, runtime: body.runtime });
  return reply.code(201).send({ bot: { id, name: body.name, runtime: body.runtime, entrypoint, status: 'stopped', created_at: now } });
});
app.post('/api/bots/import', async (request, reply) => {
  const query = request.query as { name?: string; runtime?: string };
  const name = String(query.name ?? '').trim(); const runtime = query.runtime;
  if (!name || name.length > 80 || !['python','node'].includes(runtime ?? '')) throw badRequest('A bot name and runtime (python or node) are required.');
  const part = await request.file({ limits: { fileSize: config.maxBotUploadBytes, files: 1 } });
  if (!part) throw badRequest('Choose a ZIP archive to import.');
  const originalName = safeFilename(part.filename);
  if (!originalName.toLowerCase().endsWith('.zip')) throw badRequest('Bot import accepts ZIP archives only.');
  const tempDir = path.join(config.storageRoot, 'tmp'); await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const zipTemp = path.join(tempDir, `${randomUUID()}.zip`); const botId = randomUUID();
  const extractTemp = path.join(tempDir, `extract-${botId}`); const projectDir = path.join(config.botRoot, botId, 'project');
  try {
    await pipeline(part.file, createWriteStream(zipTemp, { flags: 'wx', mode: 0o600 }));
    if (part.file.truncated) throw Object.assign(new Error('ZIP exceeds upload limit.'), { statusCode: 413 });
    await safeExtractZip(zipTemp, extractTemp, { maxEntries: 5000, maxExpandedBytes: 1_073_741_824, excludeSensitiveFiles: true });
    const top = await fsp.readdir(extractTemp, { withFileTypes: true });
    let sourceDir = extractTemp;
    if (top.length === 1 && top[0].isDirectory()) sourceDir = path.join(extractTemp, top[0].name);
    await fsp.mkdir(projectDir, { recursive: true, mode: 0o750 }); await copyTree(sourceDir, projectDir);
    const files = await fsp.readdir(projectDir);
    const detected = runtime === 'python' ? (files.includes('main.py') ? 'main.py' : files.includes('bot.py') ? 'bot.py' : files.includes('app.py') ? 'app.py' : 'main.py') : (files.includes('index.js') ? 'index.js' : files.includes('bot.js') ? 'bot.js' : files.includes('main.js') ? 'main.js' : 'index.js');
    const now = nowIso();
    db.prepare('INSERT INTO bots (id,name,runtime,entrypoint,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(botId, name, runtime, detected, 'stopped', now, now);
    addActivity('bot', `Imported ${name} from ZIP`, { botId, runtime, originalName });
    return reply.code(201).send({ bot: { id: botId, name, runtime, entrypoint: detected, status: 'stopped' }, detectedFiles: files.length });
  } catch (error) {
    await fsp.rm(path.join(config.botRoot, botId), { recursive: true, force: true });
    throw error;
  } finally {
    await fsp.rm(zipTemp, { force: true }).catch(() => undefined);
    await fsp.rm(extractTemp, { recursive: true, force: true }).catch(() => undefined);
  }
});
app.get('/api/bots/:id', async (request) => {
  const { id } = request.params as { id: string }; const bot = requireBot(id);
  let status = bot.status; let runnerConnected = false;
  const health = await getRunnerHealth(); runnerConnected = health.connected;
  if (runnerConnected) { try { const live = await runner.status(id); status = live.status; } catch { status = 'runner-unavailable'; } }
  return { bot: { ...bot, status, installDeps: Boolean(bot.install_deps), restartOnFailure: Boolean(bot.restart_on_failure), runnerConnected } };
});
app.patch('/api/bots/:id', async (request) => {
  const { id } = request.params as { id: string }; const old = requireBot(id);
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(80).optional(), runtime: z.enum(['python','node']).optional(), entrypoint: z.string().max(240).optional(), startupCommand: z.string().max(500).optional(), installDeps: z.boolean().optional(), restartOnFailure: z.boolean().optional() }), request.body);
  const runtime = body.runtime ?? old.runtime; const entrypoint = body.entrypoint ?? old.entrypoint;
  if (!validEntryPoint(entrypoint)) throw badRequest('Entry point must be a relative path inside the project.');
  if (old.status === 'running' && (body.runtime || body.entrypoint || body.startupCommand !== undefined || body.installDeps !== undefined)) throw conflict('Stop the bot before changing its runtime or startup configuration.');
  db.prepare(`UPDATE bots SET name=?,runtime=?,entrypoint=?,startup_command=?,install_deps=?,restart_on_failure=?,updated_at=? WHERE id=?`).run(
    body.name ?? old.name, runtime, entrypoint, body.startupCommand ?? old.startup_command,
    body.installDeps === undefined ? old.install_deps : Number(body.installDeps), body.restartOnFailure === undefined ? old.restart_on_failure : Number(body.restartOnFailure), nowIso(), id);
  addActivity('bot', `Updated bot settings for ${body.name ?? old.name}`, { botId: id });
  return { ok: true };
});
app.delete('/api/bots/:id', async (request, reply) => {
  const { id } = request.params as { id: string }; const body = parseBody(z.object({ confirm: z.literal(true) }), request.body);
  const bot = requireBot(id);
  try { await runner.remove(id); } catch (err) { if (!(err instanceof RunnerUnavailableError) && !String((err as Error).message).includes('not found')) throw err; if (err instanceof RunnerUnavailableError && bot.container_id) throw err; }
  const oldBackups = db.prepare('SELECT blob_name FROM backups WHERE bot_id=?').all(id) as { blob_name: string }[];
  db.prepare('DELETE FROM bots WHERE id=?').run(id);
  await fsp.rm(path.join(config.botRoot, id), { recursive: true, force: true });
  await Promise.all(oldBackups.map(item => fsp.rm(backupPath(item.blob_name), { force: true }).catch(() => undefined)));
  addActivity('bot', `Deleted bot ${bot.name}`, { botId: id }); return reply.code(204).send();
});
async function lifecycle(request: FastifyRequest, action: 'start'|'deploy'|'stop'|'restart') {
  const { id } = request.params as { id: string }; const bot = requireBot(id);
  try {
    let result: any;
    if (action === 'start' || action === 'deploy') result = await runner.start(id, action === 'deploy');
    else if (action === 'stop') result = await runner.stop(id);
    else result = await runner.restart(id);
    const status = String(result.status ?? (action === 'stop' ? 'stopped' : 'running'));
    db.prepare('UPDATE bots SET status=?,container_id=COALESCE(?,container_id),last_error=?,last_deployed_at=CASE WHEN ? THEN ? ELSE last_deployed_at END,updated_at=? WHERE id=?')
      .run(status, result.containerId ?? null, result.lastError ?? null, action === 'deploy' || action === 'start' ? 1 : 0, nowIso(), nowIso(), id);
    addActivity('bot', `${action === 'deploy' ? 'Deployed' : action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted'} bot ${bot.name}`, { botId: id, status });
    return { ok: true, status, message: result.message ?? `${action} request completed.`, containerId: result.containerId };
  } catch (error) { db.prepare('UPDATE bots SET last_error=?,updated_at=? WHERE id=?').run(String((error as Error).message).slice(0, 1000), nowIso(), id); throw error; }
}
for (const action of ['start','stop','restart','deploy'] as const) {
  app.post(`/api/bots/:id/${action}`, async (request) => lifecycle(request, action));
}
app.get('/api/bots/:id/status', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id);
  const health = await getRunnerHealth(); if (!health.connected) return { connected: false, status: 'runner-unavailable', message: health.message };
  const status = await runner.status(id); db.prepare('UPDATE bots SET status=?,last_error=?,updated_at=? WHERE id=?').run(status.status, status.lastError ?? null, nowIso(), id); return { connected: true, ...status };
});
app.get('/api/bots/:id/logs', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id); const result = await runner.logs(id); return { logs: result.logs ?? '', status: result.status ?? 'unknown', fetchedAt: nowIso() };
});
app.get('/api/bots/:id/stats', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id); return await runner.stats(id);
});
app.post('/api/bots/:id/console-command', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id);
  const { command } = parseBody(z.object({ command: z.string().trim().min(1).max(80) }), request.body);
  const parts = command.split(/\s+/); const cmd = parts[0].toLowerCase();
  if (cmd === 'help') return { output: 'Available panel commands: help, status, restart. This console is not a host shell.' };
  if (cmd === 'status') { const result = await runner.status(id); return { output: `Bot status: ${result.status}\nContainer: ${result.containerId ?? 'not created'}` }; }
  if (cmd === 'restart' && parts.length === 1) { const result = await runner.restart(id); addActivity('bot', `Restarted bot from console`, { botId: id }); return { output: `Restart request completed. Current status: ${result.status ?? 'unknown'}` }; }
  throw badRequest('Unsupported panel command. Use help, status, or restart. Arbitrary shell commands are disabled.');
});

app.get('/api/bots/:id/files', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id);
  const query = request.query as { path?: string };
  const relative = query.path ?? '';
  if (relative.includes('\\')) throw badRequest('Invalid path.');
  const root = path.join(config.botRoot, id, 'project'); const target = resolveInside(root, relative || '.');
  const realRoot = await fsp.realpath(root); const realTarget = await fsp.realpath(target).catch(() => { throw notFound('Project folder not found.'); });
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) throw forbidden('Path is outside the project.');
  const stat = await fsp.stat(realTarget); if (!stat.isDirectory()) throw badRequest('Path is not a directory.');
  const entries = await fsp.readdir(realTarget, { withFileTypes: true });
  const files = await Promise.all(entries.filter(e => !e.isSymbolicLink() && e.name !== '.env' && !e.name.startsWith('.env.') && !['node_modules','.git','.venv','venv','__pycache__'].includes(e.name) && !e.name.endsWith('.pem') && !e.name.endsWith('.key')).map(async e => {
    const full = path.join(realTarget, e.name); const s = await fsp.lstat(full);
    return { name: e.name, type: s.isDirectory() ? 'folder' : 'file', size: s.isFile() ? s.size : 0, modifiedAt: s.mtime.toISOString() };
  }));
  return { path: relative, entries: files.sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1) };
});
app.get('/api/bots/:id/files/download', async (request, reply) => {
  const { id } = request.params as { id: string }; requireBot(id); const { path: relative = '' } = request.query as { path?: string };
  if (!relative || relative.includes('\\')) throw badRequest('A relative file path is required.');
  const root = path.join(config.botRoot,id,'project'); const target = resolveInside(root,relative); const realRoot = await fsp.realpath(root); const actual = await fsp.realpath(target).catch(()=>{throw notFound('File not found.');});
  if (!actual.startsWith(realRoot + path.sep)) throw forbidden('Path is outside the project.');
  if (path.basename(actual) === '.env' || path.basename(actual).startsWith('.env.') || /\.(pem|key)$/i.test(actual)) throw forbidden('Secret configuration files cannot be downloaded through the panel.');
  const st = await fsp.stat(actual); if (!st.isFile() || st.isSymbolicLink()) throw badRequest('Requested path is not a regular file.');
  reply.header('Content-Length', st.size).header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(actual))}`).header('X-Content-Type-Options','nosniff');
  return reply.send(fs.createReadStream(actual));
});

app.get('/api/bots/:id/environment', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id);
  const rows = db.prepare('SELECT key,updated_at FROM bot_env WHERE bot_id=? ORDER BY key').all(id) as any[];
  return { variables: rows.map(r => ({ key: r.key, isSet: true, updatedAt: r.updated_at })) };
});
app.put('/api/bots/:id/environment', async (request) => {
  const { id } = request.params as { id: string }; requireBot(id);
  const body = parseBody(z.object({ set: z.array(z.object({ key: z.string().min(1).max(128), value: z.string().max(16_384) })).max(100).default([]), remove: z.array(z.string().min(1).max(128)).max(100).default([]) }), request.body);
  for (const item of body.set) if (!validEnvKey(item.key)) throw badRequest(`Environment variable name is invalid or reserved: ${item.key}`);
  for (const key of body.remove) if (!validEnvKey(key)) throw badRequest(`Environment variable name is invalid or reserved: ${key}`);
  const transaction = db.transaction(() => {
    for (const item of body.set) db.prepare(`INSERT INTO bot_env (bot_id,key,encrypted_value,updated_at) VALUES (?,?,?,?) ON CONFLICT(bot_id,key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`).run(id, item.key, encryptSecret(item.value), nowIso());
    for (const key of body.remove) db.prepare('DELETE FROM bot_env WHERE bot_id=? AND key=?').run(id,key);
  }); transaction();
  addActivity('bot', 'Updated environment variables', { botId: id, changed: body.set.map(e=>e.key), removed: body.remove });
  return { ok: true, variables: (db.prepare('SELECT key,updated_at FROM bot_env WHERE bot_id=? ORDER BY key').all(id) as any[]).map(r=>({ key:r.key,isSet:true,updatedAt:r.updated_at })) };
});

// General-purpose file cloud. Disk objects are opaque IDs; user filenames never become filesystem paths.
app.get('/api/files', async (request) => {
  const q = request.query as { folderId?: string; search?: string; sort?: string; direction?: string };
  const folderId = q.folderId || null; requireFolder(folderId);
  const search = String(q.search ?? '').trim().slice(0,200); const sortMap: Record<string,string> = { name:'name COLLATE NOCASE', size:'size', type:'mime_type', modified:'updated_at' };
  const sort = sortMap[q.sort ?? 'name'] ?? sortMap.name; const direction = q.direction === 'desc' ? 'DESC' : 'ASC';
  const files = db.prepare(`SELECT id,name,folder_id,size,mime_type,created_at,updated_at FROM files WHERE folder_id IS ? AND name LIKE ? ORDER BY ${sort} ${direction} LIMIT 1000`).all(folderId, `%${search.replace(/[\\%_]/g, c => `\\${c}`)}%`) as any[];
  const folders = db.prepare(`SELECT id,name,parent_id,created_at,updated_at FROM folders WHERE parent_id IS ? AND name LIKE ? ORDER BY name COLLATE NOCASE ASC LIMIT 1000`).all(folderId, `%${search}%`) as any[];
  const crumbs: any[] = []; let current = folderId ? db.prepare('SELECT id,name,parent_id FROM folders WHERE id=?').get(folderId) as any : null;
  while (current) { crumbs.unshift({ id: current.id, name: current.name }); current = current.parent_id ? db.prepare('SELECT id,name,parent_id FROM folders WHERE id=?').get(current.parent_id) as any : null; }
  const folderCount = (db.prepare('SELECT COUNT(*) AS n FROM folders').get() as any).n;
  const fileStats = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM files').get() as any;
  return { folderId, breadcrumbs: [{ id: null, name: 'Home' }, ...crumbs], folders, files, storage: { usedBytes: fileStats.bytes, fileCount: fileStats.count, folderCount, limitBytes: config.maxStorageBytes, percent: Math.min(100, Math.round(fileStats.bytes / config.maxStorageBytes * 100)) } };
});
app.post('/api/files/folders', async (request, reply) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(120), parentId: z.string().uuid().nullable().optional() }), request.body);
  requireFolder(body.parentId ?? null);
  const name = safeFilename(body.name);
  if ((db.prepare('SELECT id FROM folders WHERE parent_id IS ? AND name=? COLLATE NOCASE').get(body.parentId ?? null, name))) throw conflict('A folder with that name already exists here.');
  const id = randomUUID(); const now = nowIso(); db.prepare('INSERT INTO folders (id,name,parent_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name, body.parentId ?? null, now, now);
  addActivity('file', `Created folder ${name}`, { folderId: id }); return reply.code(201).send({ folder: { id, name, parent_id: body.parentId ?? null, created_at: now } });
});
app.post('/api/files/upload', async (request, reply) => {
  const query = request.query as { folderId?: string };
  const folderId = query.folderId || null; requireFolder(folderId);
  const part = await request.file({ limits: { fileSize: config.maxFileBytes, files: 1 } }); if (!part) throw badRequest('Choose a file to upload.');
  const name = safeFilename(part.filename); const uploadId = randomUUID(); const blobName = newBlobName(); const target = blobPath(blobName); let bytes = 0;
  const contentLength = Number(request.headers['content-length']);
  const hasContentLength = Number.isFinite(contentLength) && contentLength > 0;
  if (hasContentLength && contentLength > config.maxFileBytes + 2 * 1024 * 1024) throw Object.assign(new Error('Upload exceeds the configured file-size limit.'), { statusCode: 413 });
  const free = await diskAvailableBytes(config.storageRoot);
  if (free !== null && free < 10 * 1024 * 1024) throw Object.assign(new Error('The VPS disk is nearly full.'), { statusCode: 507 });
  const reservation = db.transaction(() => {
    const stored = (db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM files').get() as any).s as number;
    const pending = (db.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM uploads WHERE status='uploading'`).get() as any).s as number;
    const base = stored + pending;
    const reserveBytes = hasContentLength ? contentLength : Math.min(config.maxFileBytes, Math.max(0, config.maxStorageBytes - base));
    if (base + reserveBytes > config.maxStorageBytes || reserveBytes <= 0) throw Object.assign(new Error('Storage limit reached.'), { statusCode: 413 });
    db.prepare('INSERT INTO uploads (id,name,size,status,created_at) VALUES (?,?,?,?,?)').run(uploadId, name, reserveBytes, 'uploading', nowIso());
    return base;
  });
  const current = reservation();
  const counter = new (await import('node:stream')).Transform({ transform(chunk: Buffer, _enc, cb) { bytes += chunk.length; if (bytes > config.maxFileBytes || current + bytes > config.maxStorageBytes) return cb(Object.assign(new Error('Upload exceeds the configured storage limit.'), { statusCode: 413 })); cb(null, chunk); } });
  try {
    await pipeline(part.file, counter, createWriteStream(target, { flags: 'wx', mode: 0o640 }));
    if (part.file.truncated) throw Object.assign(new Error('Upload exceeds the configured file size limit.'), { statusCode: 413 });
    const mimeType = mime.lookup(name) || 'application/octet-stream'; const now = nowIso();
    const id = randomUUID(); db.prepare('INSERT INTO files (id,name,folder_id,blob_name,size,mime_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, name, folderId, blobName, bytes, mimeType, now, now);
    db.prepare('UPDATE uploads SET file_id=?,size=?,status=? WHERE id=?').run(id, bytes, 'completed', uploadId);
    addActivity('file', `Uploaded ${name}`, { fileId: id, bytes });
    return reply.code(201).send({ file: { id, name, folder_id: folderId, size: bytes, mime_type: mimeType, created_at: now }, uploadedBytes: bytes, totalBytes: bytes });
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => undefined);
    db.prepare('UPDATE uploads SET size=?,status=?,error=? WHERE id=?').run(bytes, 'failed', String((err as Error).message).slice(0,300), uploadId);
    throw err;
  }
});
app.get('/api/files/uploads', async () => ({ uploads: db.prepare('SELECT id,file_id,name,size,status,error,created_at FROM uploads ORDER BY created_at DESC LIMIT 100').all() }));
app.get('/api/files/:id/download', async (request, reply) => {
  const { id } = request.params as { id: string }; const file = db.prepare('SELECT * FROM files WHERE id=?').get(id) as any; if (!file) throw notFound('File not found.');
  const target = blobPath(file.blob_name); const stat = await fsp.stat(target).catch(() => { throw notFound('Stored file content is missing.'); });
  const preview = (request.query as { preview?: string }).preview === '1';
  const inlineTypes = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav','application/pdf','text/plain','application/json']);
  const contentType = preview && inlineTypes.has(file.mime_type) ? file.mime_type : 'application/octet-stream';
  reply.header('Content-Length', stat.size).header('Content-Type', contentType).header('Content-Disposition', `${preview && inlineTypes.has(file.mime_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`).header('X-Content-Type-Options','nosniff');
  if (preview) reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self';");
  return reply.send(fs.createReadStream(target));
});
app.patch('/api/files/:id/rename', async (request) => {
  const { id } = request.params as { id: string }; const body = parseBody(z.object({ name: z.string().trim().min(1).max(240) }), request.body); const file = db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
  if (file) { const name=safeFilename(body.name); db.prepare('UPDATE files SET name=?,updated_at=? WHERE id=?').run(name,nowIso(),id); addActivity('file',`Renamed file to ${name}`,{fileId:id}); return { ok:true,name }; }
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(id) as any; if (!folder) throw notFound('File or folder not found.');
  const name = safeFilename(body.name); if (db.prepare('SELECT id FROM folders WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id<>?').get(folder.parent_id,name,id)) throw conflict('A folder with that name already exists here.');
  db.prepare('UPDATE folders SET name=?,updated_at=? WHERE id=?').run(name,nowIso(),id); addActivity('file',`Renamed folder to ${name}`,{folderId:id}); return { ok:true,name };
});
app.post('/api/files/:id/move', async (request) => {
  const { id } = request.params as { id: string }; const body = parseBody(z.object({ targetFolderId: z.string().uuid().nullable() }), request.body); requireFolder(body.targetFolderId);
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
  if (file) { if (file.folder_id !== body.targetFolderId) { db.prepare('UPDATE files SET folder_id=?,updated_at=? WHERE id=?').run(body.targetFolderId,nowIso(),id); addActivity('file',`Moved file ${file.name}`,{fileId:id,targetFolderId:body.targetFolderId}); } return { ok:true }; }
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(id) as any; if (!folder) throw notFound('File or folder not found.');
  if (body.targetFolderId === id) throw badRequest('A folder cannot be moved into itself.');
  let current = body.targetFolderId; while(current) { if (current === id) throw badRequest('A folder cannot be moved inside one of its descendants.'); const parent = db.prepare('SELECT parent_id FROM folders WHERE id=?').get(current) as any; current = parent?.parent_id ?? null; }
  db.prepare('UPDATE folders SET parent_id=?,updated_at=? WHERE id=?').run(body.targetFolderId,nowIso(),id); addActivity('file',`Moved folder ${folder.name}`,{folderId:id,targetFolderId:body.targetFolderId}); return { ok:true };
});
app.post('/api/files/:id/copy', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = parseBody(z.object({ targetFolderId: z.string().uuid().nullable().optional(), name: z.string().max(240).optional() }), request.body);
  const targetFolder = body.targetFolderId ?? null;
  requireFolder(targetFolder);
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
  const currentBytes = () => {
    const stored = (db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM files').get() as any).s as number;
    const pending = (db.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM uploads WHERE status='uploading'`).get() as any).s as number;
    return stored + pending;
  };
  if (file) {
    if (currentBytes() + file.size > config.maxStorageBytes) throw Object.assign(new Error('Copy would exceed the configured storage limit.'), { statusCode: 413 });
    const diskFree = await diskAvailableBytes(config.storageRoot);
    if (diskFree !== null && diskFree < file.size) throw Object.assign(new Error('Not enough free disk space to copy this file.'), { statusCode: 507 });
    const newId = randomUUID(); const blob = newBlobName();
    const name = safeFilename(body.name ?? `${path.parse(file.name).name} copy${path.extname(file.name)}`);
    const now = nowIso();
    await fsp.copyFile(blobPath(file.blob_name), blobPath(blob), fs.constants.COPYFILE_EXCL);
    try {
      db.prepare('INSERT INTO files (id,name,folder_id,blob_name,size,mime_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(newId,name,targetFolder,blob,file.size,file.mime_type,now,now);
    } catch (error) { await fsp.rm(blobPath(blob), { force: true }).catch(() => undefined); throw error; }
    addActivity('file', `Copied ${file.name}`, { fileId: newId, sourceId: id });
    return reply.code(201).send({ ok: true, id: newId, name });
  }
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(id) as any;
  if (!folder) throw notFound('File or folder not found.');
  const sourceFolderIds = [id];
  for (let i=0; i<sourceFolderIds.length; i++) sourceFolderIds.push(...(db.prepare('SELECT id FROM folders WHERE parent_id=?').all(sourceFolderIds[i]) as any[]).map(x=>x.id));
  const sourcePlaceholders = sourceFolderIds.map(() => '?').join(',');
  const copyBytes = (db.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE folder_id IN (${sourcePlaceholders})`).get(...sourceFolderIds) as any).s as number;
  if (currentBytes() + copyBytes > config.maxStorageBytes) throw Object.assign(new Error('Copy would exceed the configured storage limit.'), { statusCode: 413 });
  const diskFree = await diskAvailableBytes(config.storageRoot);
  if (diskFree !== null && diskFree < copyBytes) throw Object.assign(new Error('Not enough free disk space to copy this folder.'), { statusCode: 507 });

  const newFolderId = randomUUID(); const now = nowIso();
  const rootName = safeFilename(body.name ?? `${folder.name} copy`);
  db.prepare('INSERT INTO folders (id,name,parent_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(newFolderId,rootName,targetFolder,now,now);
  const clone = (oldFolderId: string, newParentId: string) => {
    for (const f of db.prepare('SELECT * FROM folders WHERE parent_id=?').all(oldFolderId) as any[]) {
      const childId = randomUUID();
      db.prepare('INSERT INTO folders (id,name,parent_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(childId,f.name,newParentId,now,now);
      clone(f.id,childId);
    }
    for (const f of db.prepare('SELECT * FROM files WHERE folder_id=?').all(oldFolderId) as any[]) {
      const newFileId = randomUUID(); const blob = newBlobName();
      fs.copyFileSync(blobPath(f.blob_name),blobPath(blob),fs.constants.COPYFILE_EXCL);
      try { db.prepare('INSERT INTO files (id,name,folder_id,blob_name,size,mime_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(newFileId,f.name,newParentId,blob,f.size,f.mime_type,now,now); }
      catch(error) { fs.rmSync(blobPath(blob),{force:true}); throw error; }
    }
  };
  try { clone(id,newFolderId); }
  catch(error) {
    const rollbackIds = [newFolderId];
    for(let i=0; i<rollbackIds.length; i++) rollbackIds.push(...(db.prepare('SELECT id FROM folders WHERE parent_id=?').all(rollbackIds[i]) as any[]).map(x=>x.id));
    const placeholders = rollbackIds.map(()=>'?').join(',');
    const copied = db.prepare(`SELECT blob_name FROM files WHERE folder_id IN (${placeholders})`).all(...rollbackIds) as any[];
    const tx = db.transaction(() => { db.prepare(`DELETE FROM files WHERE folder_id IN (${placeholders})`).run(...rollbackIds); db.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...rollbackIds); });
    tx(); await Promise.all(copied.map(f=>fsp.rm(blobPath(f.blob_name),{force:true}).catch(()=>undefined))); throw error;
  }
  addActivity('file', `Copied folder ${folder.name}`, { folderId: newFolderId });
  return reply.code(201).send({ ok: true, id: newFolderId, name: rootName });
});
app.delete('/api/files/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
  if (file) { db.prepare('DELETE FROM files WHERE id=?').run(id); await fsp.rm(blobPath(file.blob_name),{force:true}); addActivity('file',`Deleted ${file.name}`,{fileId:id}); return reply.code(204).send(); }
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(id) as any; if (!folder) throw notFound('File or folder not found.');
  const folderIds=[id]; for(let i=0;i<folderIds.length;i++) folderIds.push(...(db.prepare('SELECT id FROM folders WHERE parent_id=?').all(folderIds[i]) as any[]).map(x=>x.id));
  const placeholders=folderIds.map(()=>'?').join(','); const nestedFiles=db.prepare(`SELECT id,blob_name FROM files WHERE folder_id IN (${placeholders})`).all(...folderIds) as any[];
  const tx=db.transaction(()=>{ db.prepare(`DELETE FROM files WHERE folder_id IN (${placeholders})`).run(...folderIds); db.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...folderIds); }); tx();
  await Promise.all(nestedFiles.map(f=>fsp.rm(blobPath(f.blob_name),{force:true}).catch(()=>undefined)));
  addActivity('file',`Deleted folder ${folder.name} and its contents`,{folderId:id,fileCount:nestedFiles.length}); return reply.code(204).send();
});
app.get('/api/files/storage', async () => {
  const stats=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS files FROM files').get() as any; const disk=await diskAvailableBytes(config.storageRoot);
  return { usedBytes:stats.bytes,files:stats.files,limitBytes:config.maxStorageBytes,diskAvailableBytes:disk,percent:Math.min(100,Math.round(stats.bytes/config.maxStorageBytes*100)) };
});

// Backups are generated from workspace files only; .env/private keys and dependency folders are excluded.
app.get('/api/backups', async () => ({ backups: db.prepare(`SELECT b.id,b.bot_id,b.name,b.size,b.status,b.created_at,bot.name AS bot_name FROM backups b JOIN bots bot ON bot.id=b.bot_id ORDER BY b.created_at DESC LIMIT 300`).all() }));
app.post('/api/bots/:id/backups', async (request, reply) => {
  const { id } = request.params as { id: string }; const bot = requireBot(id); const project=path.join(config.botRoot,id,'project'); const blobName=`${randomUUID()}.zip`; const target=backupPath(blobName);
  try {
    await createWorkspaceZip(project,target); const st=await fsp.stat(target); const backupId=randomUUID(); const name=`${bot.name} · ${new Date().toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'})} UTC`;
    db.prepare('INSERT INTO backups (id,bot_id,name,blob_name,size,status,created_at) VALUES (?,?,?,?,?,?,?)').run(backupId,id,name,blobName,st.size,'completed',nowIso());
    addActivity('backup',`Created backup for ${bot.name}`,{botId:id,backupId,size:st.size}); return reply.code(201).send({backup:{id:backupId,bot_id:id,name,size:st.size,status:'completed'}});
  } catch(error) { await fsp.rm(target,{force:true}); throw error; }
});
app.get('/api/backups/:id/download', async (request, reply) => {
  const {id}=request.params as {id:string}; const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(id) as any; if(!backup) throw notFound('Backup not found.'); const p=backupPath(backup.blob_name); const st=await fsp.stat(p).catch(()=>{throw notFound('Backup archive is missing.');});
  reply.header('Content-Type','application/zip').header('Content-Length',st.size).header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(`${backup.name}.zip`)}`).header('X-Content-Type-Options','nosniff'); return reply.send(fs.createReadStream(p));
});
app.post('/api/backups/:id/restore', async (request) => {
  const {id}=request.params as {id:string}; parseBody(z.object({confirm:z.literal(true)}),request.body); const backup=db.prepare('SELECT * FROM backups WHERE id=?').get(id) as any; if(!backup) throw notFound('Backup not found.'); const bot=requireBot(backup.bot_id);
  const health=await getRunnerHealth(); if(health.connected) await runner.stop(bot.id); else if(bot.container_id) throw new RunnerUnavailableError('Cannot safely restore this workspace while its runner is disconnected.');
  const temp=path.join(config.storageRoot,'tmp',`restore-${randomUUID()}`);
  const project=path.join(config.botRoot,bot.id,'project');
  try {
    await safeExtractZip(backupPath(backup.blob_name),temp,{maxEntries:5000,maxExpandedBytes:1_073_741_824,excludeSensitiveFiles:true});
    const staged=path.join(config.botRoot,bot.id,`restore-staged-${randomUUID()}`);
    try {
      await copyTree(temp,staged);
      const previous=path.join(config.botRoot,bot.id,`restore-previous-${randomUUID()}`);
      const existed=await fsp.stat(project).then(()=>true).catch(()=>false);
      if(existed) await fsp.rename(project,previous);
      try { await fsp.rename(staged,project); } catch(error) { if(existed) await fsp.rename(previous,project).catch(()=>undefined); throw error; }
      if(existed) await fsp.rm(previous,{recursive:true,force:true});
    } finally { await fsp.rm(staged,{recursive:true,force:true}).catch(()=>undefined); }
  } finally { await fsp.rm(temp,{recursive:true,force:true}).catch(()=>undefined); }
  db.prepare('UPDATE bots SET status=?,last_error=NULL,updated_at=? WHERE id=?').run('stopped',nowIso(),bot.id); addActivity('backup',`Restored backup for ${bot.name}`,{botId:bot.id,backupId:id}); return {ok:true,status:'stopped',message:'Backup restored. Start the bot to run the restored files.'};
});

app.get('/api/activity', async (request) => {
  const q=request.query as {limit?:string;type?:string}; const limit=Math.min(200,Math.max(1,Number(q.limit)||50));
  const rows=q.type ? db.prepare('SELECT * FROM activity WHERE type=? ORDER BY created_at DESC LIMIT ?').all(q.type,limit) : db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit);
  return {activity:(rows as any[]).map(a=>({...a,details:a.detail_json?JSON.parse(a.detail_json):null,detail_json:undefined}))};
});
app.get('/api/settings', async (request) => {
  const values=Object.fromEntries((db.prepare('SELECT key,value FROM settings').all() as any[]).map(s=>[s.key,s.value]));
  const services=await getRunnerHealth(); const storage=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM files').get() as any;
  return { profile:{id:request.admin!.id,username:request.admin!.username,email:request.admin!.email,displayName:request.admin!.display_name},preferences:{theme:values.theme??'system'},storage:{usedBytes:storage.bytes,limitBytes:config.maxStorageBytes,fileCount:storage.count},services:{api:true,database:true,runner:services.connected,runnerMessage:services.message,encryptionKeyConfigured:Boolean(config.encryptionKey)} };
});
app.put('/api/settings/preferences', async (request) => {
  const body=parseBody(z.object({displayName:z.string().trim().min(1).max(80),theme:z.enum(['light','dark','system'])}),request.body); const now=nowIso();
  db.prepare('UPDATE admin SET display_name=? WHERE id=?').run(body.displayName,request.admin!.id); db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('theme',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(body.theme,now);
  addActivity('settings','Updated account preferences'); return {ok:true};
});
app.put('/api/settings/password', async (request) => {
  const body=parseBody(z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(12).max(128)}),request.body); const admin=db.prepare('SELECT password_hash FROM admin WHERE id=?').get(request.admin!.id) as any;
  if(!await verifyPassword(body.currentPassword,admin.password_hash)) throw Object.assign(new Error('Current password is incorrect.'),{statusCode:401});
  const hash=await hashPassword(body.newPassword); db.prepare('UPDATE admin SET password_hash=? WHERE id=?').run(hash,request.admin!.id); db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(request.admin!.id,request.sessionId); addActivity('security','Administrator changed password'); return {ok:true};
});

// NODEBASE WATCH alpha: private Cloud-backed MP4/WebM rooms with range streaming and server-authoritative playback.
// HLS transcoding, WebSocket synchronization, and resumable chunk uploads remain separate follow-up milestones.
const watchCookieName = (roomId: string) => `nb_watch_${roomId.replace(/-/g, '')}`;
function requireWatchRoom(roomId: string) {
  const room = db.prepare('SELECT * FROM watch_rooms WHERE id=?').get(roomId) as any;
  if (!room) throw notFound('Watch room not found.');
  return room;
}
function requireWatchOwner(roomId: string, userId: string) {
  const room = requireWatchRoom(roomId);
  if (room.owner_id !== userId) throw forbidden('Only the room host can perform this action.');
  return room;
}
function requireWatchGuest(roomId: string, request: FastifyRequest, allowPending = false) {
  const token = request.cookies[watchCookieName(roomId)];
  if (!token) throw Object.assign(new Error('Join this room using a valid invitation.'), { statusCode: 401 });
  const participant = db.prepare(`SELECT * FROM watch_participants WHERE room_id=? AND session_hash=? AND status IN ('joined','pending')`).get(roomId, sha256(token)) as any;
  if (!participant) throw Object.assign(new Error('Your room access has expired or was revoked.'), { statusCode: 401 });
  if (!allowPending && participant.status !== 'joined') throw Object.assign(new Error('Your request is waiting for host approval.'), { statusCode: 403 });
  db.prepare('UPDATE watch_participants SET last_seen_at=? WHERE id=?').run(nowIso(), participant.id);
  return participant;
}
function requireWatchMember(roomId: string, request: FastifyRequest, allowPending = false) {
  const room = requireWatchRoom(roomId);
  let participant: any = null;
  if (request.admin) {
    participant = db.prepare(`SELECT * FROM watch_participants WHERE room_id=? AND user_id=? AND status IN ('joined','pending')`).get(roomId, request.admin.id) as any;
    if (!participant && room.owner_id === request.admin.id) throw forbidden('Host membership is missing.');
  } else {
    return requireWatchGuest(roomId, request, allowPending);
  }
  if (!participant) throw forbidden('You are not a participant in this watch room.');
  if (!allowPending && participant.status !== 'joined') throw Object.assign(new Error('Your request is waiting for host approval.'), { statusCode: 403 });
  db.prepare('UPDATE watch_participants SET last_seen_at=? WHERE id=?').run(nowIso(), participant.id);
  return participant;
}
function watchSnapshot(roomId: string, viewer?: { userId?: string; role?: string }) {
  const room = requireWatchRoom(roomId);
  const viewerRole = viewer?.role ?? (viewer?.userId ? (db.prepare('SELECT role FROM watch_participants WHERE room_id=? AND user_id=? AND status=\'joined\'').get(roomId, viewer.userId) as any)?.role : undefined);
  const isHost = viewer?.userId === room.owner_id || viewerRole === 'host';
  const canControl = isHost || viewerRole === 'cohost' || Boolean(room.viewer_control_enabled);
  const video = db.prepare('SELECT id,name,size,mime_type,created_at FROM files WHERE id=?').get(room.current_video_file_id) as any;
  const participants = db.prepare(`SELECT id,display_name,role,status,joined_at,last_seen_at FROM watch_participants WHERE room_id=? AND status IN ('joined','pending') ORDER BY CASE role WHEN 'host' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END, joined_at`).all(roomId);
  const queue = db.prepare(`SELECT q.id,q.position,q.created_at,f.id AS file_id,f.name,f.size,f.mime_type FROM watch_queue_items q JOIN files f ON f.id=q.file_id WHERE q.room_id=? ORDER BY q.position`).all(roomId);
  const messages = db.prepare(`SELECT m.id,m.body,m.created_at,p.display_name,p.role FROM watch_messages m JOIN watch_participants p ON p.id=m.participant_id WHERE m.room_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 50`).all(roomId).reverse();
  const elapsed = room.playback_state === 'playing' ? Math.max(0, Date.now() - new Date(room.playback_updated_at).getTime()) : 0;
  return {
    room: { id:room.id,title:room.title,description:room.description,category:room.category,visibility:room.visibility,status:room.status,participantLimit:room.participant_limit,approvalRequired:Boolean(room.approval_required),chatEnabled:Boolean(room.chat_enabled),viewerControlEnabled:Boolean(room.viewer_control_enabled),createdAt:room.created_at },
    video: video ? { id:video.id,name:video.name,size:video.size,mimeType:video.mime_type,delivery:'progressive',streamReady:true } : null,
    playback: { state:room.playback_state,positionMs:room.playback_position_ms + (room.playback_state === 'playing' ? elapsed : 0),playbackRate:room.playback_rate,sequence:room.playback_sequence,serverTime:nowIso(),updatedAt:room.playback_updated_at },
    participants,queue,messages,
    permissions: { isHost, canControl, canInvite:isHost, canManageParticipants:isHost, canManageQueue:isHost },
    mediaCapabilities: { progressiveMp4Webm:true,hls:false,websocketSync:false,resumableChunkUpload:false }
  };
}
function sendWatchMedia(roomId: string, request: FastifyRequest, reply: FastifyReply) {
  const room = requireWatchRoom(roomId);
  if (room.status === 'ended' || room.status === 'expired') throw conflict('This watch room has ended.');
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(room.current_video_file_id) as any;
  if (!file) throw notFound('The room video is no longer available.');
  if (!['video/mp4','video/webm'].includes(file.mime_type)) throw Object.assign(new Error('The alpha player currently supports MP4 and WebM files. HLS processing is not enabled yet.'),{statusCode:415});
  const target = blobPath(file.blob_name);
  let stat: any;
  try { stat = fs.statSync(target); } catch { throw notFound('Stored video content is missing.'); }
  if (!stat.isFile() || stat.size <= 0) throw badRequest('The selected video file is empty or unavailable.');
  const range = request.headers.range;
  let start = 0; let end = stat.size - 1; let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const unsatisfied = () => reply.code(416).header('Content-Range', `bytes */${stat.size}`).header('Accept-Ranges', 'bytes').send();
    if (!match || (!match[1] && !match[2])) return unsatisfied();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfied();
      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);
      if (!Number.isSafeInteger(start)) return unsatisfied();
    }
    if (match[2] && match[1]) {
      const requestedEnd = Number(match[2]);
      if (!Number.isSafeInteger(requestedEnd)) return unsatisfied();
      end = Math.min(stat.size - 1, requestedEnd);
    }
    if (start >= stat.size || end < start) return unsatisfied();
    status = 206;
  }
  reply.code(status).header('Accept-Ranges','bytes').header('Content-Type',file.mime_type).header('Content-Length',end-start+1).header('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`).header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
  if (status === 206) reply.header('Content-Range',`bytes ${start}-${end}/${stat.size}`);
  return reply.send(fs.createReadStream(target,{start,end}));
}
const watchRoomCreateSchema = z.object({ title:z.string().trim().min(2).max(100),description:z.string().trim().max(500).default(''),category:z.string().trim().min(1).max(40).default('General'),videoFileId:z.string().uuid(),visibility:z.enum(['private','discoverable_private']).default('private'),participantLimit:z.number().int().min(2).max(50).default(12),approvalRequired:z.boolean().default(false),chatEnabled:z.boolean().default(true),viewerControlEnabled:z.boolean().default(false) });
app.get('/api/watch/overview', async (request) => {
  const videos = db.prepare(`SELECT id,name,size,mime_type,created_at,updated_at FROM files WHERE mime_type IN ('video/mp4','video/webm') ORDER BY updated_at DESC LIMIT 200`).all();
  const rooms = db.prepare(`SELECT r.id,r.title,r.description,r.visibility,r.status,r.created_at,r.updated_at,f.name AS video_name,(SELECT COUNT(*) FROM watch_participants p WHERE p.room_id=r.id AND p.status='joined') AS participant_count FROM watch_rooms r JOIN files f ON f.id=r.current_video_file_id WHERE r.owner_id=? AND r.status<>'ended' ORDER BY r.updated_at DESC LIMIT 100`).all(request.admin!.id);
  return { videos,rooms,capabilities:{progressiveStreaming:true,hls:false,websocketSync:false,resumableChunkUpload:false,liveBroadcasting:false} };
});
app.get('/api/watch/discovery', async (request) => ({ rooms:db.prepare(`SELECT r.id,r.title,r.description,r.category,r.status,r.created_at,r.approval_required,a.display_name AS host_name,(SELECT COUNT(*) FROM watch_participants p WHERE p.room_id=r.id AND p.status='joined') AS participant_count,(SELECT p.status FROM watch_participants p WHERE p.room_id=r.id AND p.user_id=? LIMIT 1) AS my_status FROM watch_rooms r JOIN admin a ON a.id=r.owner_id WHERE r.visibility='discoverable_private' AND r.status IN ('waiting','playing','paused') AND r.owner_id<>? ORDER BY r.created_at DESC LIMIT 100`).all(request.admin!.id,request.admin!.id) }));
app.post('/api/watch/discovery/:id/request', async (request,reply) => {
  const {id}=request.params as {id:string};const room=requireWatchRoom(id);
  if(room.visibility!=='discoverable_private'||room.status==='ended'||room.status==='expired')throw notFound('This room is not discoverable.');
  if(room.owner_id===request.admin!.id)throw conflict('You already host this room.');
  const result=db.transaction(()=>{
    const fresh=requireWatchRoom(id);
    if(fresh.visibility!=='discoverable_private'||fresh.status==='ended'||fresh.status==='expired')throw notFound('This room is not discoverable.');
    const existing=db.prepare(`SELECT * FROM watch_participants WHERE room_id=? AND user_id=?`).get(id,request.admin!.id) as any;
    if(existing&&existing.status==='joined')return {status:'joined' as const,created:false,message:'You already have access to this room.'};
    if(existing&&existing.status==='pending')return {status:'pending' as const,created:false,message:'Your access request is already awaiting approval.'};
    const count=(db.prepare(`SELECT COUNT(*) AS n FROM watch_participants WHERE room_id=? AND status IN ('joined','pending')`).get(id) as any).n;
    if(count>=fresh.participant_limit)throw conflict('This room has reached its participant limit.');
    const status=fresh.approval_required?'pending' as const:'joined' as const;const now=nowIso();
    if(existing) db.prepare(`UPDATE watch_participants SET display_name=?,role='viewer',status=?,joined_at=?,last_seen_at=?,left_at=NULL,session_hash=NULL WHERE id=?`).run(request.admin!.display_name,status,now,now,existing.id);
    else db.prepare(`INSERT INTO watch_participants (id,room_id,user_id,display_name,role,status,joined_at,last_seen_at) VALUES (?,?,?,?,'viewer',?,?,?)`).run(randomUUID(),id,request.admin!.id,request.admin!.display_name,status,now,now);
    return {status,created:!existing,message:status==='pending'?'Your request was sent to the host.':'You joined the room.'};
  })();
  addActivity('watch',result.status==='pending'?'Requested access to a watch room':'Joined a discoverable watch room',{roomId:id});
  return reply.code(result.created?201:200).send({status:result.status,message:result.message});
});

app.post('/api/watch/rooms', async (request, reply) => {
  const body=parseBody(watchRoomCreateSchema,request.body);
  const file=db.prepare(`SELECT id,name,mime_type FROM files WHERE id=?`).get(body.videoFileId) as any;
  if(!file) throw notFound('Select a video from your Cloud library.');
  if(!['video/mp4','video/webm'].includes(file.mime_type)) throw badRequest('WATCH alpha supports MP4 and WebM files only.');
  const id=randomUUID(); const now=nowIso();
  const create=db.transaction(()=>{
    db.prepare(`INSERT INTO watch_rooms (id,owner_id,title,description,category,visibility,status,current_video_file_id,participant_limit,approval_required,chat_enabled,viewer_control_enabled,playback_state,playback_position_ms,playback_rate,playback_sequence,playback_updated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'waiting',?,?,?,?,?,'paused',0,1,0,?,?,?)`).run(id,request.admin!.id,body.title,body.description,body.category,body.visibility,body.videoFileId,body.participantLimit,body.approvalRequired?1:0,body.chatEnabled?1:0,body.viewerControlEnabled?1:0,now,now,now);
    db.prepare(`INSERT INTO watch_participants (id,room_id,user_id,display_name,role,status,joined_at,last_seen_at) VALUES (?,?,?,?,'host','joined',?,?)`).run(randomUUID(),id,request.admin!.id,request.admin!.display_name,now,now);
  });
  create(); addActivity('watch','Created watch room',{roomId:id,videoFileId:body.videoFileId});
  return reply.code(201).send(watchSnapshot(id,{userId:request.admin!.id,role:'host'}));
});
app.get('/api/watch/rooms', async (request) => ({ rooms:db.prepare(`SELECT r.id,r.title,r.description,r.category,r.visibility,r.status,r.created_at,r.updated_at,f.id AS video_file_id,f.name AS video_name,(SELECT COUNT(*) FROM watch_participants p WHERE p.room_id=r.id AND p.status='joined') AS participant_count FROM watch_rooms r JOIN files f ON f.id=r.current_video_file_id WHERE r.owner_id=? ORDER BY r.updated_at DESC`).all(request.admin!.id) }));
app.get('/api/watch/rooms/:id', async (request) => { const {id}=request.params as {id:string}; const participant=requireWatchMember(id,request); return watchSnapshot(id,{userId:request.admin?.id,role:participant.role}); });
app.post('/api/watch/rooms/:id/invitations', async (request,reply) => {
  const {id}=request.params as {id:string}; requireWatchOwner(id,request.admin!.id);
  const body=parseBody(z.object({expiresInHours:z.number().int().min(1).max(168).default(24),maxUses:z.number().int().min(1).max(500).default(20)}),request.body);
  const token=randomToken(32); const inviteId=randomUUID(); const created=nowIso(); const expires=new Date(Date.now()+body.expiresInHours*3600000).toISOString();
  db.prepare('INSERT INTO watch_invitations (id,room_id,token_hash,created_by,expires_at,max_uses,created_at) VALUES (?,?,?,?,?,?,?)').run(inviteId,id,sha256(token),request.admin!.id,expires,body.maxUses,created);
  addActivity('watch','Created a watch invitation',{roomId:id,invitationId:inviteId,expiresAt:expires});
  return reply.code(201).send({invitation:{id:inviteId,token,expiresAt:expires,maxUses:body.maxUses}});
});
app.delete('/api/watch/invitations/:id', async (request,reply) => {
  const {id}=request.params as {id:string}; const invite=db.prepare('SELECT i.*,r.owner_id FROM watch_invitations i JOIN watch_rooms r ON r.id=i.room_id WHERE i.id=?').get(id) as any;
  if(!invite) throw notFound('Invitation not found.'); if(invite.owner_id!==request.admin!.id) throw forbidden('Only the room host can revoke this invitation.');
  db.prepare('UPDATE watch_invitations SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(nowIso(),id); addActivity('watch','Revoked a watch invitation',{invitationId:id}); return reply.code(204).send();
});
function findWatchInvite(token:string) {
  const invite=db.prepare(`SELECT i.*,r.title,r.description,r.status,r.visibility,r.participant_limit,r.approval_required,a.display_name AS host_name FROM watch_invitations i JOIN watch_rooms r ON r.id=i.room_id JOIN admin a ON a.id=r.owner_id WHERE i.token_hash=?`).get(sha256(token)) as any;
  if(!invite || invite.revoked_at || invite.expires_at<=nowIso() || invite.used_count>=invite.max_uses || invite.status==='ended' || invite.status==='expired') throw notFound('This invitation is invalid, expired, revoked or already used up.');
  return invite;
}
const watchInviteTokenSchema = z.string().min(40).max(200);
app.post('/api/watch/invitations/resolve', {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, async (request) => {
  const body=parseBody(z.object({token:watchInviteTokenSchema}),request.body);
  const i=findWatchInvite(body.token);
  const count=(db.prepare(`SELECT COUNT(*) AS n FROM watch_participants WHERE room_id=? AND status IN ('joined','pending')`).get(i.room_id) as any).n;
  if(count>=i.participant_limit) throw conflict('This watch room has reached its participant limit.');
  return {room:{id:i.room_id,title:i.title,description:i.description,hostName:i.host_name,visibility:i.visibility,participantCount:count,participantLimit:i.participant_limit,approvalRequired:Boolean(i.approval_required)}};
});
app.post('/api/watch/invitations/join', {config:{rateLimit:{max:10,timeWindow:'1 minute'}}}, async (request,reply) => {
  const body=parseBody(z.object({token:watchInviteTokenSchema,displayName:z.string().trim().min(2).max(40)}),request.body);
  const guestToken=randomToken(32); const participantId=randomUUID(); const now=nowIso();
  // Re-check invitation validity and room capacity inside one transaction. This makes the
  // max-use counter and participant reservation atomic even when multiple guests join together.
  const joined=db.transaction(()=>{
    const i=findWatchInvite(body.token);
    const count=(db.prepare(`SELECT COUNT(*) AS n FROM watch_participants WHERE room_id=? AND status IN ('joined','pending')`).get(i.room_id) as any).n;
    if(count>=i.participant_limit) throw conflict('This watch room has reached its participant limit.');
    const reserved=db.prepare(`UPDATE watch_invitations SET used_count=used_count+1 WHERE id=? AND used_count<max_uses AND revoked_at IS NULL AND expires_at>?`).run(i.id,now);
    if(!reserved.changes) throw notFound('This invitation is invalid, expired, revoked or already used up.');
    const status=i.approval_required?'pending':'joined';
    db.prepare(`INSERT INTO watch_participants (id,room_id,display_name,role,status,session_hash,joined_at,last_seen_at) VALUES (?,?,?,'viewer',?,?,?,?)`).run(participantId,i.room_id,body.displayName,status,sha256(guestToken),now,now);
    return {roomId:i.room_id,status};
  })();
  reply.setCookie(watchCookieName(joined.roomId),guestToken,{httpOnly:true,secure:config.nodeEnv==='production',sameSite:'lax',path:`/api/watch/guest/${joined.roomId}`,maxAge:24*60*60});
  if(joined.status==='joined') addActivity('watch','A guest joined a watch room',{roomId:joined.roomId,participantId});
  return reply.code(201).send({roomId:joined.roomId,participantId,status:joined.status,message:joined.status==='pending'?'Your request is waiting for host approval.':'You joined the watch room.'});
});
app.post('/api/watch/rooms/:id/participants/:participantId/approve', async (request) => {
  const {id,participantId}=request.params as {id:string;participantId:string}; requireWatchOwner(id,request.admin!.id);
  const result=db.prepare(`UPDATE watch_participants SET status='joined',last_seen_at=? WHERE id=? AND room_id=? AND status='pending'`).run(nowIso(),participantId,id);
  if(!result.changes) throw notFound('Pending participant not found.'); addActivity('watch','Approved a watch room participant',{roomId:id,participantId}); return {ok:true};
});
app.delete('/api/watch/rooms/:id/participants/:participantId', async (request,reply) => {
  const {id,participantId}=request.params as {id:string;participantId:string}; requireWatchOwner(id,request.admin!.id);
  const result=db.prepare(`UPDATE watch_participants SET status='removed',session_hash=NULL,left_at=? WHERE id=? AND room_id=? AND role<>'host' AND status IN ('joined','pending')`).run(nowIso(),participantId,id);
  if(!result.changes) throw notFound('Removable participant not found.'); return reply.code(204).send();
});
function applyWatchPlayback(roomId:string,body:{action:'play'|'pause'|'seek'|'end';positionMs?:number;playbackRate?:number}) {
  const room=requireWatchRoom(roomId); if(room.status==='ended'||room.status==='expired') throw conflict('This room has ended.');
  const now=nowIso(); const position=Math.max(0,Math.min(7*24*60*60*1000,Math.floor(body.positionMs??room.playback_position_ms)));
  const state=body.action==='play'?'playing':body.action==='pause'?'paused':body.action==='end'?'ended':room.playback_state; const sequence=room.playback_sequence+1;
  const tx=db.transaction(()=>{
    db.prepare(`UPDATE watch_rooms SET playback_state=?,playback_position_ms=?,playback_rate=?,playback_sequence=?,playback_updated_at=?,status=?,updated_at=?,ended_at=? WHERE id=?`).run(state,position,body.playbackRate??room.playback_rate,sequence,now,body.action==='end'?'ended':state,now,body.action==='end'?now:null,roomId);
    db.prepare('INSERT INTO watch_room_events (id,room_id,sequence,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(),roomId,sequence,body.action,JSON.stringify({positionMs:position,playbackRate:body.playbackRate??room.playback_rate}),now);
  }); tx(); return {state,positionMs:position,playbackRate:body.playbackRate??room.playback_rate,sequence,serverTime:now};
}
const playbackSchema=z.object({action:z.enum(['play','pause','seek','end']),positionMs:z.number().int().min(0).max(7*24*60*60*1000).optional(),playbackRate:z.number().min(0.5).max(2).optional()});
app.get('/api/watch/rooms/:id/playback',async(request)=>{const {id}=request.params as {id:string};requireWatchMember(id,request);return {playback:watchSnapshot(id).playback};});
app.post('/api/watch/rooms/:id/playback',async(request)=>{const {id}=request.params as {id:string};const participant=requireWatchMember(id,request);const room=requireWatchRoom(id);if(participant.role!=='host'&&participant.role!=='cohost'&&!room.viewer_control_enabled)throw forbidden('Only the host can control synchronized playback.');const b=parseBody(playbackSchema,request.body);return {playback:applyWatchPlayback(id,b)};});
app.get('/api/watch/rooms/:id/media',async(request,reply)=>{const {id}=request.params as {id:string};requireWatchMember(id,request);return sendWatchMedia(id,request,reply);});
app.get('/api/watch/rooms/:id/messages',async(request)=>{const {id}=request.params as {id:string};requireWatchMember(id,request);return {messages:watchSnapshot(id).messages};});
app.post('/api/watch/rooms/:id/messages',async(request,reply)=>{
  const {id}=request.params as {id:string};const participant=requireWatchMember(id,request);const room=requireWatchRoom(id);if(!room.chat_enabled)throw forbidden('Room chat is disabled.');
  const body=parseBody(z.object({body:z.string().trim().min(1).max(1000)}),request.body);const created=nowIso();const mid=randomUUID();db.prepare('INSERT INTO watch_messages (id,room_id,participant_id,body,created_at) VALUES (?,?,?,?,?)').run(mid,id,participant.id,body.body,created);return reply.code(201).send({message:{id:mid,body:body.body,display_name:participant.display_name,role:participant.role,created_at:created}});
});
app.post('/api/watch/rooms/:id/leave',async(request)=>{const {id}=request.params as {id:string};const participant=requireWatchMember(id,request);if(participant.role==='host')throw conflict('The host must end the room instead of leaving it.');db.prepare(`UPDATE watch_participants SET status='left',session_hash=NULL,left_at=? WHERE id=? AND room_id=?`).run(nowIso(),participant.id,id);return {ok:true};});
app.get('/api/watch/guest/:id',async(request)=>{
  const {id}=request.params as {id:string};const participant=requireWatchGuest(id,request,true);const room=requireWatchRoom(id);
  if(participant.status==='pending')return {status:'pending',room:{id,title:room.title,description:room.description},message:'Waiting for the host to approve your request.'};
  return {status:'joined',...watchSnapshot(id,{role:participant.role}),participant:{id:participant.id,displayName:participant.display_name,role:participant.role}};
});
app.get('/api/watch/guest/:id/playback',async(request)=>{const {id}=request.params as {id:string};requireWatchGuest(id,request);return {playback:watchSnapshot(id).playback};});
app.post('/api/watch/guest/:id/playback',async(request)=>{
  const {id}=request.params as {id:string};const participant=requireWatchGuest(id,request);const room=requireWatchRoom(id);if(participant.role!=='host'&&participant.role!=='cohost'&&!room.viewer_control_enabled)throw forbidden('Only the host can control synchronized playback.');const body=parseBody(playbackSchema,request.body);return {playback:applyWatchPlayback(id,body)};
});
app.get('/api/watch/guest/:id/media',async(request,reply)=>{const {id}=request.params as {id:string};requireWatchGuest(id,request);return sendWatchMedia(id,request,reply);});
app.get('/api/watch/guest/:id/messages',async(request)=>{const {id}=request.params as {id:string};requireWatchGuest(id,request);return {messages:watchSnapshot(id).messages};});
app.post('/api/watch/guest/:id/messages',async(request,reply)=>{
  const {id}=request.params as {id:string};const participant=requireWatchGuest(id,request);const room=requireWatchRoom(id);if(!room.chat_enabled)throw forbidden('Room chat is disabled.');const body=parseBody(z.object({body:z.string().trim().min(1).max(1000)}),request.body);const messageId=randomUUID();const created=nowIso();db.prepare('INSERT INTO watch_messages (id,room_id,participant_id,body,created_at) VALUES (?,?,?,?,?)').run(messageId,id,participant.id,body.body,created);return reply.code(201).send({message:{id:messageId,body:body.body,display_name:participant.display_name,role:participant.role,created_at:created}});
});
app.get('/api/watch/guest/:id/queue',async(request)=>{const {id}=request.params as {id:string};requireWatchGuest(id,request);return {queue:watchSnapshot(id).queue};});
app.post('/api/watch/guest/:id/leave',async(request,reply)=>{const {id}=request.params as {id:string};const participant=requireWatchGuest(id,request,true);db.prepare(`UPDATE watch_participants SET status='left',session_hash=NULL,left_at=? WHERE id=? AND room_id=?`).run(nowIso(),participant.id,id);reply.clearCookie(watchCookieName(id),{path:`/api/watch/guest/${id}`});return {ok:true};});
app.post('/api/watch/rooms/:id/queue',async(request,reply)=>{
  const {id}=request.params as {id:string};requireWatchOwner(id,request.admin!.id);const body=parseBody(z.object({fileId:z.string().uuid()}),request.body);const file=db.prepare(`SELECT id,name,mime_type FROM files WHERE id=?`).get(body.fileId) as any;if(!file||!['video/mp4','video/webm'].includes(file.mime_type))throw badRequest('Choose an MP4 or WebM video from Cloud.');const position=(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM watch_queue_items WHERE room_id=?').get(id) as any).p;const itemId=randomUUID();db.prepare('INSERT INTO watch_queue_items (id,room_id,file_id,added_by,position,created_at) VALUES (?,?,?,?,?,?)').run(itemId,id,file.id,request.admin!.id,position,nowIso());return reply.code(201).send({item:{id:itemId,position,file_id:file.id,name:file.name,size:0,mime_type:file.mime_type}});
});
app.delete('/api/watch/rooms/:id/queue/:itemId',async(request,reply)=>{const {id,itemId}=request.params as {id:string;itemId:string};requireWatchOwner(id,request.admin!.id);const result=db.prepare('DELETE FROM watch_queue_items WHERE id=? AND room_id=?').run(itemId,id);if(!result.changes)throw notFound('Queue item not found.');return reply.code(204).send();});
app.post('/api/watch/rooms/:id/end',async(request)=>{const {id}=request.params as {id:string};requireWatchOwner(id,request.admin!.id);const now=nowIso();db.prepare(`UPDATE watch_rooms SET status='ended',playback_state='ended',ended_at=?,updated_at=?,playback_sequence=playback_sequence+1 WHERE id=?`).run(now,now,id);db.prepare('UPDATE watch_participants SET status=CASE WHEN status IN (\'joined\',\'pending\') THEN \'left\' ELSE status END,session_hash=NULL,left_at=? WHERE room_id=?').run(now,id);db.prepare('UPDATE watch_invitations SET revoked_at=? WHERE room_id=? AND revoked_at IS NULL').run(now,id);addActivity('watch','Ended a watch room',{roomId:id});return {ok:true};});

// Serve the Vite build when deployed as a single container. In development, Vite serves the UI itself.
if (fs.existsSync(path.join(config.staticDir,'index.html'))) {
  await app.register(fastifyStatic,{root:config.staticDir,prefix:'/',decorateReply:false,wildcard:false});
  app.setNotFoundHandler((request,reply)=> {
    if(request.url.startsWith('/api/')) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Endpoint not found.'}});
    return reply.type('text/html').send(fs.createReadStream(path.join(config.staticDir,'index.html')));
  });
} else {
  app.setNotFoundHandler((request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Endpoint not found.'}}));
}

const shutdown = async () => { try { await app.close(); db.close(); } finally { process.exit(0); } };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
export { app };
if (process.env.NODEBASE_DISABLE_LISTEN !== '1') {
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) { app.log.error(error); process.exit(1); }
}
