import { config } from './config.js';
import { db } from './db.js';
import { decryptSecret } from './security.js';

export class RunnerUnavailableError extends Error { constructor(message = 'The host runner is not connected. Install and configure the restricted runner before using bot lifecycle controls.') { super(message); } }
async function callRunner<T>(route: string, method = 'GET', body?: unknown, timeoutMs = 20_000): Promise<T> {
  if (!config.runnerUrl || !config.runnerToken) throw new RunnerUnavailableError();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.runnerUrl}${route}`, {
      method, signal: controller.signal,
      headers: { Authorization: `Bearer ${config.runnerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Runner returned HTTP ${response.status}.`);
    return data as T;
  } catch (error) {
    if (error instanceof RunnerUnavailableError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Runner request timed out.');
    throw new Error(`Runner request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally { clearTimeout(timeout); }
}
export async function getRunnerHealth() {
  if (!config.runnerUrl || !config.runnerToken) return { connected: false, message: 'Runner not configured' };
  try { const status = await callRunner<{ ok: boolean }>('/health'); return status.ok ? { connected: true, message: 'Runner connected' } : { connected: false, message: 'Runner cannot access Docker' }; }
  catch { return { connected: false, message: 'Runner unreachable' }; }
}
export async function botRunnerPayload(botId: string) {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as any;
  if (!bot) throw new Error('Bot not found.');
  const env = db.prepare('SELECT key, encrypted_value FROM bot_env WHERE bot_id=?').all(botId) as { key: string; encrypted_value: string }[];
  let variables: Record<string, string> = {};
  if (env.length) variables = Object.fromEntries(env.map(item => [item.key, decryptSecret(item.encrypted_value)]));
  return {
    id: bot.id, runtime: bot.runtime, entrypoint: bot.entrypoint, startupCommand: bot.startup_command,
    installDeps: Boolean(bot.install_deps), restartOnFailure: Boolean(bot.restart_on_failure), env: variables,
  };
}
export const runner = {
  status: (id: string) => callRunner<any>(`/v1/bots/${id}/status`),
  start: async (id: string, deploy = false) => callRunner<any>(`/v1/bots/${id}/${deploy ? 'deploy' : 'start'}`, 'POST', await botRunnerPayload(id), 600_000),
  stop: (id: string) => callRunner<any>(`/v1/bots/${id}/stop`, 'POST'),
  restart: (id: string) => callRunner<any>(`/v1/bots/${id}/restart`, 'POST'),
  logs: (id: string) => callRunner<any>(`/v1/bots/${id}/logs`),
  stats: (id: string) => callRunner<any>(`/v1/bots/${id}/stats`),
  remove: (id: string) => callRunner<any>(`/v1/bots/${id}`, 'DELETE'),
};
