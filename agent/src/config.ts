import path from 'node:path';

export interface AgentConfig {
  controlPlaneUrl: string;
  enrollmentToken: string;
  nodeName: string;
  region: string;
  runtimes: Array<'python' | 'node'>;
  storagePath: string;
  credentialsFile: string;
  agentVersion: string;
}

export function normalizeControlPlaneUrl(value: string, nodeEnv = 'production'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('NODEBASE_CONTROL_PLANE_URL must be a valid absolute URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Control-plane URL must not contain credentials, query parameters, or a fragment.');
  const localHttp = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) && (nodeEnv !== 'production');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttp)) {
    throw new Error('The node agent requires HTTPS in production. HTTP is allowed only for loopback development URLs.');
  }
  return url.toString().replace(/\/$/, '');
}

export function parseAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const controlPlaneUrl = normalizeControlPlaneUrl(env.NODEBASE_CONTROL_PLANE_URL ?? '', env.NODE_ENV ?? 'production');
  const nodeName = (env.NODEBASE_NODE_NAME ?? '').trim();
  if (nodeName.length < 2 || nodeName.length > 80) throw new Error('Set NODEBASE_NODE_NAME (2–80 characters).');
  const runtimes = [...new Set((env.NODEBASE_AGENT_RUNTIMES ?? 'python,node').split(',').map(v => v.trim()).filter((v): v is 'python' | 'node' => v === 'python' || v === 'node'))];
  if (!runtimes.length) throw new Error('NODEBASE_AGENT_RUNTIMES must include python, node, or both.');
  const credentialsFile = path.resolve(env.NODEBASE_AGENT_TOKEN_FILE ?? '/var/lib/nodebase-agent/credentials.json');
  const enrollmentToken = (env.NODEBASE_ENROLLMENT_TOKEN ?? '').trim();
  return {
    controlPlaneUrl,
    enrollmentToken,
    nodeName,
    region: (env.NODEBASE_REGION ?? '').trim().slice(0, 80),
    runtimes,
    storagePath: path.resolve(env.NODEBASE_AGENT_STORAGE_PATH ?? '/'),
    credentialsFile,
    agentVersion: env.NODEBASE_AGENT_VERSION ?? '0.2.0',
  };
}
