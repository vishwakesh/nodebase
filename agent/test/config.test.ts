import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControlPlaneUrl, parseAgentConfig } from '../src/config.js';

test('production agent rejects non-HTTPS control planes', () => {
  assert.throws(() => normalizeControlPlaneUrl('http://panel.example.test', 'production'), /requires HTTPS/);
});

test('development agent permits loopback HTTP only', () => {
  assert.equal(normalizeControlPlaneUrl('http://127.0.0.1:3001/', 'development'), 'http://127.0.0.1:3001');
  assert.throws(() => normalizeControlPlaneUrl('http://192.168.1.5:3001', 'development'), /requires HTTPS/);
});

test('agent parses node identity and known runtimes', () => {
  const config = parseAgentConfig({
    NODEBASE_CONTROL_PLANE_URL: 'https://panel.example.test',
    NODEBASE_NODE_NAME: 'Worker Tokyo',
    NODEBASE_AGENT_RUNTIMES: 'python,node',
    NODE_ENV: 'production',
  });
  assert.equal(config.nodeName, 'Worker Tokyo');
  assert.deepEqual(config.runtimes, ['python', 'node']);
});
