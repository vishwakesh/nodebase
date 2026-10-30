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
  if (publicPaths.has(pathname) || request.method === 'OPTIONS') return;
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
  return { profile:{id:request.admin!.id,username:request.admin!.username,email:request.admin!.email,displayName:request.admin!.display_name},preferences:{theme:values.theme??'light'},storage:{usedBytes:storage.bytes,limitBytes:config.maxStorageBytes,fileCount:storage.count},services:{api:true,database:true,runner:services.connected,runnerMessage:services.message,encryptionKeyConfigured:Boolean(config.encryptionKey)} };
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
