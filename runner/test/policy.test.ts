import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectPathFor, validateBotId, validateEntryPoint, validateEnvironmentKey } from '../src/policy.js';

const id='d07bd9ec-25e4-4f69-8d36-7b1e9c1e2d45';
test('runner accepts only UUID bot identities and derives contained workspace paths',()=>{
  assert.equal(validateBotId(id),id);
  assert.throws(()=>validateBotId('../../etc'));
  assert.equal(projectPathFor('/srv/nodebase/data/bots',id),path.resolve('/srv/nodebase/data/bots',id,'project'));
});
test('runner rejects traversal entry points and reserved environment keys',()=>{
  assert.equal(validateEntryPoint('src/index.js'),true);
  assert.equal(validateEntryPoint('../host.js'),false);
  assert.equal(validateEntryPoint('/tmp/pwn'),false);
  assert.equal(validateEnvironmentKey('DISCORD_TOKEN'),true);
  assert.equal(validateEnvironmentKey('NB_RUNTIME'),false);
  assert.equal(validateEnvironmentKey('NODE_OPTIONS'),false);
});
