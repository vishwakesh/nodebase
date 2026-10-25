import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import archiver from 'archiver';
import { config } from './config.js';

export const blobPath = (blobName: string) => {
  if (!/^[a-f0-9-]{36}(?:\.zip)?$/i.test(blobName)) throw new Error('Invalid stored object identifier.');
  const target = path.resolve(config.blobRoot, blobName);
  if (!target.startsWith(path.resolve(config.blobRoot) + path.sep)) throw new Error('Invalid stored object path.');
  return target;
};
export const backupPath = (blobName: string) => {
  if (!/^[a-f0-9-]{36}\.zip$/i.test(blobName)) throw new Error('Invalid backup identifier.');
  return path.join(config.backupRoot, blobName);
};
export async function diskAvailableBytes(root: string) {
  try { const s = await fsp.statfs(root); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
export async function folderSize(root: string): Promise<number> {
  let total = 0;
  async function walk(current: string) {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(p);
        else if (entry.isFile()) total += (await fsp.stat(p)).size;
      } catch { /* inaccessible files do not crash metrics */ }
    }
  }
  await walk(root);
  return total;
}

export async function safeExtractZip(archivePath: string, destination: string, options?: { maxEntries?: number; maxExpandedBytes?: number; excludeSensitiveFiles?: boolean }) {
  const maxEntries = options?.maxEntries ?? 5000;
  const maxExpandedBytes = options?.maxExpandedBytes ?? 1_073_741_824;
  await fsp.mkdir(destination, { recursive: true, mode: 0o750 });
  const root = await fsp.realpath(destination);
  let entryCount = 0;
  let expanded = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } };
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true }, (openErr, zip) => {
      if (openErr || !zip) return fail(openErr ?? new Error('Could not open ZIP archive.'));
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', (entry) => {
        (async () => {
          entryCount++;
          if (entryCount > maxEntries) throw new Error('ZIP has too many entries.');
          const name = entry.fileName;
          const leaf = name.split('/').pop() ?? '';
          if (options?.excludeSensitiveFiles && (leaf === '.env' || (leaf.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(leaf)) || leaf.endsWith('.pem') || leaf.endsWith('.key') || leaf === 'id_rsa' || leaf === 'id_ed25519')) { zip.readEntry(); return; }
          if (!name || name.includes('\\') || name.startsWith('/') || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error('ZIP contains an unsafe path.');
          const normalized = path.posix.normalize(name);
          if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('ZIP contains a path traversal entry.');
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) throw new Error('ZIP symlinks are not allowed.');
          if (entry.uncompressedSize > maxExpandedBytes || expanded + entry.uncompressedSize > maxExpandedBytes) throw new Error('ZIP expands beyond the configured safety limit.');
          expanded += entry.uncompressedSize;
          const dest = path.resolve(root, normalized);
          const relative = path.relative(root, dest);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ZIP path escapes destination.');
          if (name.endsWith('/')) {
            await fsp.mkdir(dest, { recursive: true, mode: 0o750 });
            zip.readEntry();
            return;
          }
          await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
          const parentReal = await fsp.realpath(path.dirname(dest));
          if (parentReal !== root && !parentReal.startsWith(root + path.sep)) throw new Error('ZIP path escapes destination.');
          await new Promise<void>((streamResolve, streamReject) => {
            zip.openReadStream(entry, (streamErr, source) => {
              if (streamErr || !source) return streamReject(streamErr ?? new Error('Could not read ZIP entry.'));
              let bytes = 0;
              const limiter = new Transform({ transform(chunk: Buffer, _enc, cb) { bytes += chunk.length; if (bytes > maxExpandedBytes) return cb(new Error('ZIP entry exceeded extraction limit.')); cb(null, chunk); } });
              pipeline(source, limiter, fs.createWriteStream(dest, { flags: 'wx', mode: 0o640 })).then(() => {
                if (bytes !== entry.uncompressedSize) streamReject(new Error('ZIP entry size validation failed.'));
                else streamResolve();
              }, streamReject);
            });
          });
          zip.readEntry();
        })().catch((err: Error) => { try { zip.close(); } catch {} fail(err); });
      });
      zip.readEntry();
    });
  }).catch(async (err) => { await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined); throw err; });
}

const excludedNames = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.next', 'dist', 'build']);
const excludedFile = (name: string) => name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key') || name === 'id_rsa' || name === 'id_ed25519';
export async function createWorkspaceZip(sourceDir: string, destZip: string) {
  await fsp.mkdir(path.dirname(destZip), { recursive: true, mode: 0o750 });
  const out = fs.createWriteStream(destZip, { flags: 'wx', mode: 0o600 });
  const zip = archiver('zip', { zlib: { level: 6 } });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('close', resolve); out.on('error', reject); zip.on('error', reject);
  });
  zip.pipe(out);
  async function addDir(dir: string, rel = ''): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (excludedNames.has(e.name) || excludedFile(e.name)) continue;
      const abs = path.join(dir, e.name); const arc = path.posix.join(rel, e.name);
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await addDir(abs, arc);
      else if (st.isFile()) zip.file(abs, { name: arc });
    }
  }
  try { await addDir(sourceDir); await zip.finalize(); await finished; }
  catch (error) { zip.abort(); out.destroy(); await fsp.rm(destZip, { force: true }); throw error; }
}
export async function copyTree(source: string, destination: string) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o750 });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name); const dest = path.join(destination, entry.name);
    const stat = await fsp.lstat(src);
    if (stat.isSymbolicLink()) throw new Error('Symlinks cannot be copied into bot workspaces.');
    if (stat.isDirectory()) await copyTree(src, dest);
    else if (stat.isFile()) await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  }
}
export function newBlobName() { return crypto.randomUUID(); }
