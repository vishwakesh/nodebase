import 'dotenv/config';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Docker from 'dockerode';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBotId, validateEntryPoint, projectPathFor, validateEnvironmentKey } from './policy.js';
import { z } from 'zod';

const host = process.env.RUNNER_HOST ?? '0.0.0.0';
const token = process.env.RUNNER_TOKEN ?? '';
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? '/srv/nodebase/data/bots');
function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}
const memoryMb = boundedInteger(process.env.BOT_MEMORY_MB, 512, 256, 4096);
const cpuNano = boundedInteger(process.env.BOT_CPU_NANOS, 500_000_000, 100_000_000, 2_000_000_000);
const port = boundedInteger(process.env.RUNNER_PORT, 3099, 1024, 65535);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024, trustProxy: false });

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

function equal(a: string, b: string) { const aa=Buffer.from(a); const bb=Buffer.from(b); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (!token || !equal(req.headers.authorization ?? '', `Bearer ${token}`)) return reply.code(401).send({ error: 'Unauthorized runner request.' });
});
app.setErrorHandler((error, req, reply) => {
  req.log.error({ err: error }, 'Runner operation failed');
  const status = Number((error as any).statusCode);
  reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: status >= 400 && status < 500 ? error.message : 'Runner operation failed.' });
});
function bad(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function validateId(id: string) { try { return validateBotId(id); } catch { throw bad('Invalid bot identifier.'); } }
function validEntryPoint(entry: string) { return validateEntryPoint(entry); }
function getProjectPath(id: string) { try { return projectPathFor(workspaceRoot,id); } catch { throw bad('Bot workspace path rejected.',403); } }
const botSchema = z.object({
  id: z.string().uuid(), runtime: z.enum(['python','node']), entrypoint: z.string().min(1).max(240),
  startupCommand: z.string().max(500).default(''), installDeps: z.boolean().default(true), restartOnFailure: z.boolean().default(true),
  env: z.record(z.string(), z.string().max(16_384)).default({}),
});
type BotConfig = z.infer<typeof botSchema>;
const imageFor = (runtime: BotConfig['runtime']) => runtime === 'python' ? 'python:3.12-slim' : 'node:22-bookworm-slim';
async function ensureImage(image: string) {
  try { await docker.getImage(image).inspect(); return; } catch { /* pull below */ }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve,reject)=>docker.modem.followProgress(stream,(err)=>err?reject(err):resolve()));
}
async function findContainer(id: string) {
  const list = await docker.listContainers({ all: true, filters: { label: [`nodebase.bot_id=${id}`] } });
  return list.length ? docker.getContainer(list[0].Id) : null;
}
async function inspectStatus(id: string) {
  const container = await findContainer(id);
  if (!container) return { status: 'stopped', containerId: null, uptimeSeconds: 0, lastError: null };
  const info = await container.inspect(); const state = info.State;
  const startedAt = state.StartedAt && state.StartedAt !== '0001-01-01T00:00:00Z' ? Date.parse(state.StartedAt) : 0;
  let status: string;
  if (state.Running) status = 'running';
  else if (state.Status === 'created' || state.Status === 'restarting') status = 'starting';
  else if (state.ExitCode !== 0 && state.Status === 'exited') status = 'crashed';
  else status = 'stopped';
  const lastError = state.Error || (status === 'crashed' ? `Process exited with code ${state.ExitCode}.` : null);
  return { status, containerId: info.Id, uptimeSeconds: state.Running && startedAt ? Math.max(0, Math.floor((Date.now()-startedAt)/1000)) : 0, lastError, exitCode: state.ExitCode };
}
const staticBoot = `set -eu
umask 077
mkdir -p /tmp/workspace /tmp/home
cp -a /incoming/. /tmp/workspace/
cd /tmp/workspace
if [ "$NB_INSTALL_DEPS" = "1" ]; then
  if [ "$NB_RUNTIME" = "python" ] && [ -f requirements.txt ]; then python -m pip install --user --no-cache-dir -r requirements.txt; fi
  if [ "$NB_RUNTIME" = "node" ] && [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi
fi
if [ -n "$NB_STARTUP_COMMAND" ]; then exec sh -lc "$NB_STARTUP_COMMAND"; fi
if [ "$NB_RUNTIME" = "python" ]; then exec python "$NB_ENTRYPOINT"; else exec node "$NB_ENTRYPOINT"; fi`;
async function removeBotNetwork(id: string) {
  const name = `nodebase-bot-${id}`;
  try { const net = docker.getNetwork(name); await net.inspect(); await net.remove(); } catch { /* no network to remove */ }
}
async function createBotNetwork(id: string) {
  const name = `nodebase-bot-${id}`;
  await docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: { 'nodebase.managed': 'true', 'nodebase.bot_id': id }, Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'true' } });
  return name;
}
async function createAndStart(cfg: BotConfig) {
  validateId(cfg.id);
  if (!validEntryPoint(cfg.entrypoint)) throw bad('Entry point must be a safe relative file path.');
  for (const key of Object.keys(cfg.env)) {
    if (!validateEnvironmentKey(key)) throw bad(`Environment variable is reserved or invalid: ${key}`);
  }
  const project = getProjectPath(cfg.id);
  const rootReal = await fs.realpath(workspaceRoot); const projectReal = await fs.realpath(project).catch(() => { throw bad('Bot project directory does not exist.', 404); });
  if (!projectReal.startsWith(rootReal + path.sep) || !(await fs.stat(projectReal)).isDirectory()) throw bad('Bot project directory is outside the allowed workspace.',403);
  await ensureImage(imageFor(cfg.runtime));
  const existing = await findContainer(cfg.id);
  if (existing) await existing.remove({ force: true }).catch(()=>undefined);
  await removeBotNetwork(cfg.id);
  const networkName = await createBotNetwork(cfg.id);
  const env = [
    `NB_ENTRYPOINT=${cfg.entrypoint}`, `NB_RUNTIME=${cfg.runtime}`, `NB_INSTALL_DEPS=${cfg.installDeps?'1':'0'}`,
    `NB_STARTUP_COMMAND=${cfg.startupCommand}`, `HOME=/tmp/home`, `PATH=/tmp/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...Object.entries(cfg.env).map(([k,v])=>`${k}=${v}`),
  ];
  const container = await docker.createContainer({
    Image: imageFor(cfg.runtime),
    name: `nodebase-bot-${cfg.id}`,
    Cmd: ['sh','-lc',staticBoot],
    Env: env,
    WorkingDir: '/tmp/workspace',
    User: '1000:1000',
    Tty: true,
    OpenStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { 'nodebase.managed': 'true', 'nodebase.bot_id': cfg.id, 'nodebase.runtime': cfg.runtime },
    HostConfig: {
      Binds: [`${projectReal}:/incoming:ro`],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${Math.max(192,memoryMb-128)}m,mode=1777` },
      Memory: memoryMb * 1024 * 1024,
      MemorySwap: memoryMb * 1024 * 1024,
      NanoCpus: cpuNano,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      NetworkMode: networkName,
      RestartPolicy: cfg.restartOnFailure ? { Name: 'on-failure', MaximumRetryCount: 5 } : { Name: 'no' },
      AutoRemove: false,
      Init: true,
    },
  });
  await container.start();
  return { status: 'running', containerId: container.id, message: 'Isolated bot container started.' };
}

app.get('/health', async () => {
  try { await docker.ping(); return { ok: true, docker: true }; }
  catch { return { ok: false, docker: false }; }
});
app.get('/v1/health', async () => {
  try { await docker.ping(); return { ok: true, docker: true, workspaceRoot }; } catch { return { ok: false, docker: false }; }
});
app.get('/v1/bots/:id/status', async (req) => {
  const { id } = req.params as { id: string }; validateId(id); return await inspectStatus(id);
});
app.post('/v1/bots/:id/start', async (req) => {
  const { id } = req.params as { id: string }; validateId(id); const cfg = botSchema.parse(req.body);
  if (cfg.id !== id) throw bad('Bot identifier mismatch.');
  const existing = await findContainer(id);
  if (existing) {
    const info = await existing.inspect();
    if (info.State.Running) return { ...(await inspectStatus(id)), message: 'Bot is already running.' };
    await existing.start(); return { ...(await inspectStatus(id)), message: 'Bot container started.' };
  }
  return await createAndStart(cfg);
});
app.post('/v1/bots/:id/deploy', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const cfg=botSchema.parse(req.body); if(cfg.id!==id) throw bad('Bot identifier mismatch.'); return await createAndStart(cfg);
});
app.post('/v1/bots/:id/stop', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const c=await findContainer(id); if(!c) return {status:'stopped',containerId:null,message:'No bot container is running.'};
  const info=await c.inspect(); if(info.State.Running) await c.stop({t:10}); return { ...(await inspectStatus(id)), message:'Bot container stopped.' };
});
app.post('/v1/bots/:id/restart', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const c=await findContainer(id); if(!c) throw bad('Bot has not been deployed yet. Use Deploy first.',409);
  const info=await c.inspect(); if(info.State.Running) await c.restart({t:10}); else await c.start(); return { ...(await inspectStatus(id)), message:'Bot container restarted.' };
});
app.get('/v1/bots/:id/logs', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const c=await findContainer(id); if(!c) return {status:'stopped',logs:'No container logs yet.'};
  const status=await inspectStatus(id); const result=await c.logs({stdout:true,stderr:true,follow:false,timestamps:true,tail:500}); return { status:status.status, logs:Buffer.isBuffer(result)?result.toString('utf8'):String(result), containerId:status.containerId };
});
app.get('/v1/bots/:id/stats', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const c=await findContainer(id); if(!c) return {status:'stopped',cpuPercent:null,memoryUsageBytes:0,memoryLimitBytes:memoryMb*1024*1024};
  const status=await inspectStatus(id); if(status.status!=='running') return {...status,cpuPercent:0,memoryUsageBytes:0,memoryLimitBytes:memoryMb*1024*1024};
  const stats=await c.stats({stream:false}) as any; const cpuDelta=stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage; const systemDelta=stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage; const cpus=stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpuPercent=cpuDelta>0 && systemDelta>0 ? Math.round((cpuDelta/systemDelta)*cpus*1000)/10 : 0;
  return {...status,cpuPercent,memoryUsageBytes:stats.memory_stats?.usage ?? 0,memoryLimitBytes:stats.memory_stats?.limit ?? memoryMb*1024*1024};
});
app.delete('/v1/bots/:id', async (req) => {
  const { id }=req.params as {id:string}; validateId(id); const c=await findContainer(id); if(c) await c.remove({force:true}); await removeBotNetwork(id); return {ok:true,status:'stopped'};
});

if (!token || token.length < 32 || /^replace[-_]/i.test(token)) {
  app.log.error('RUNNER_TOKEN must be a non-placeholder random value of at least 32 characters. Runner will not start without it.');
  process.exit(1);
}
const shutdown=async()=>{try{await app.close();}finally{process.exit(0)}};
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
try { await app.listen({host,port}); }
catch (e) { app.log.error(e); process.exit(1); }
