import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAgentConfig } from './config.js';

const config = parseAgentConfig(process.env);
const HEARTBEAT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
type Credentials = { nodeId: string; nodeToken: string; controlPlaneUrl: string };
let previousCpu: { idle: number; total: number } | null = null;
let stopping = false;

function log(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) {
  // Never include credentials, Authorization headers, or request bodies in agent logs.
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, component: 'nodebase-agent', message, ...detail })}\n`);
}

async function requestJson<T>(endpoint: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${config.controlPlaneUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const error = new Error(typeof payload?.error?.message === 'string' ? payload.error.message : `Control plane returned HTTP ${response.status}.`);
    (error as any).statusCode = response.status;
    throw error;
  }
  return payload as T;
}

async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fsp.readFile(config.credentialsFile, 'utf8');
    const value = JSON.parse(raw) as Credentials;
    if (!value.nodeId || !value.nodeToken || !value.controlPlaneUrl) throw new Error('Credentials file is incomplete.');
    if (value.controlPlaneUrl !== config.controlPlaneUrl) throw new Error('Saved node credential belongs to a different control-plane URL; refusing to forward it.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function saveCredentials(credentials: Credentials) {
  const dir = path.dirname(config.credentialsFile);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${config.credentialsFile}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temp, config.credentialsFile);
  await fsp.chmod(config.credentialsFile, 0o600);
}

async function enroll(): Promise<Credentials> {
  if (!config.enrollmentToken) throw new Error('No saved node credential was found. Set NODEBASE_ENROLLMENT_TOKEN to a short-lived token created from the NODEBASE dashboard.');
  const cpuCores = Math.max(1, os.cpus().length);
  const memoryTotalBytes = os.totalmem();
  const storage = storageStats();
  const response = await requestJson<{ node: { id: string }; nodeToken: string }>('/api/agent/enroll', {
    token: config.enrollmentToken,
    body: { name: config.nodeName, region: config.region, agentVersion: config.agentVersion, runtimes: config.runtimes, cpuCores, memoryTotalBytes, storageTotalBytes: storage.totalBytes },
  });
  const credentials = { nodeId: response.node.id, nodeToken: response.nodeToken, controlPlaneUrl: config.controlPlaneUrl };
  await saveCredentials(credentials);
  log('info', 'Node enrolled successfully', { nodeId: credentials.nodeId, nodeName: config.nodeName, region: config.region || 'unspecified' });
  return credentials;
}

function storageStats() {
  try {
    const stats = fs.statfsSync(config.storagePath);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { totalBytes: Math.max(0, totalBytes), usedBytes: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return { totalBytes: 0, usedBytes: 0 };
  }
}

async function cpuPercent(): Promise<number | null> {
  try {
    const text = await fsp.readFile('/proc/stat', 'utf8');
    const first = text.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (first.length < 4 || first.some(n => !Number.isFinite(n))) return null;
    const idle = first[3] + (first[4] ?? 0);
    const total = first.reduce((sum, n) => sum + n, 0);
    const previous = previousCpu;
    previousCpu = { idle, total };
    if (!previous || total <= previous.total) return null;
    const deltaTotal = total - previous.total;
    const deltaIdle = idle - previous.idle;
    return Math.round(Math.max(0, Math.min(100, (1 - deltaIdle / deltaTotal) * 100)) * 10) / 10;
  } catch { return null; }
}

async function heartbeat(credentials: Credentials) {
  const memoryTotalBytes = os.totalmem();
  const storage = storageStats();
  return requestJson<{ ok: boolean; nextHeartbeatSeconds: number }>('/api/agent/heartbeat', {
    token: credentials.nodeToken,
    body: {
      agentVersion: config.agentVersion,
      cpuPercent: await cpuPercent(),
      memoryTotalBytes,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem()),
      storageTotalBytes: storage.totalBytes,
      storageUsedBytes: storage.usedBytes,
      runtimes: config.runtimes,
      // Workload inventory is intentionally omitted until the node runtime manager is implemented.
      // The control plane represents it as unknown instead of displaying a fabricated zero.
    },
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  log('info', 'Starting node agent', { version: config.agentVersion, controlPlane: config.controlPlaneUrl, runtimes: config.runtimes });
  let credentials = await loadCredentials();
  if (!credentials) credentials = await enroll();
  let backoff = 2_000;
  while (!stopping) {
    try {
      await heartbeat(credentials);
      backoff = 2_000;
      await sleep(HEARTBEAT_MS);
    } catch (error) {
      const status = Number((error as any)?.statusCode ?? 0);
      if (status === 401 || status === 403) {
        log('error', 'Node credential was rejected or revoked; stop and re-enroll the node.', { statusCode: status });
        process.exitCode = 1;
        break;
      }
      log('warn', 'Heartbeat failed; will retry with backoff', { error: error instanceof Error ? error.message : String(error), retryInMs: backoff });
      await sleep(backoff);
      backoff = Math.min(60_000, backoff * 2);
    }
  }
  log('info', 'Node agent stopped');
}

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
main().catch(error => {
  log('error', 'Node agent could not start', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
