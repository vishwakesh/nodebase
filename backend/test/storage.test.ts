import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import archiver from 'archiver';
import { resolveInside, validEntryPoint, validEnvKey, safeFilename } from '../src/security.js';
import { safeExtractZip } from '../src/storage.js';

test('path and filename policy rejects traversal and unsafe entry points', () => {
  assert.throws(()=>resolveInside('/srv/nodebase/files','../outside.txt'));
  assert.throws(()=>resolveInside('/srv/nodebase/files','/etc/passwd'));
  assert.equal(validEntryPoint('src/main.py'),true);
  assert.equal(validEntryPoint('../main.py'),false);
  assert.equal(validEntryPoint('/etc/passwd'),false);
  assert.equal(validEnvKey('DISCORD_TOKEN'),true);
  assert.equal(validEnvKey('NB_STARTUP_COMMAND'),false);
  assert.equal(validEnvKey('LD_PRELOAD'),false);
  assert.equal(safeFilename('../../My file.txt'),'My file.txt');
});

test('ZIP extraction rejects traversal entries and removes partial output', async () => {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nodebase-zip-test-'));
  const zipPath=path.join(temp,'bad.zip'); const destination=path.join(temp,'extract');
  const output=(await import('node:fs')).createWriteStream(zipPath);
  const zip=archiver('zip'); zip.pipe(output); zip.append('owned',{name:'../escape.txt'}); await zip.finalize(); await once(output,'close');
  await assert.rejects(()=>safeExtractZip(zipPath,destination));
  await assert.rejects(()=>fs.stat(path.join(temp,'escape.txt')));
  await assert.rejects(()=>fs.stat(destination));
  await fs.rm(temp,{recursive:true,force:true});
});
