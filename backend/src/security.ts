import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { config, encryptionKeyBytes } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'nb_session';
const CSRF_COOKIE = 'nb_csrf';
export { SESSION_COOKIE, CSRF_COOKIE };

export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function sha256(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt$${salt.toString('base64')}$${result.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string) {
  try {
    const [kind, saltB64, hashB64] = stored.split('$');
    if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64'); const expected = Buffer.from(hashB64, 'base64');
    const candidate = await scrypt(password, salt, expected.length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  } catch { return false; }
}

export function encryptSecret(value: string) {
  const key = encryptionKeyBytes();
  if (!key) throw new Error('NODEBASE_ENCRYPTION_KEY must be a base64-encoded 32-byte key to save environment secrets.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}
export function decryptSecret(value: string) {
  const key = encryptionKeyBytes();
  if (!key) throw new Error('NODEBASE_ENCRYPTION_KEY must be a base64-encoded 32-byte key to use environment secrets.');
  const [ivB64, tagB64, dataB64] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function safeFilename(input: string) {
  const normalized = input.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = normalized.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid filename.');
  return [...clean].slice(0, 240).join('');
}
export function validEnvKey(key: string) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !key.startsWith('NB_') && !['PATH','HOME','PWD','LD_PRELOAD','NODE_OPTIONS','PYTHONPATH','PYTHONHOME'].includes(key);
}
export function validEntryPoint(input: string) {
  if (!input || input.length > 240 || input.startsWith('/') || input.includes('\\')) return false;
  const parts = input.split('/');
  return parts.every(p => p && p !== '.' && p !== '..') && !path.posix.isAbsolute(input);
}
export function resolveInside(root: string, relative: string) {
  if (path.isAbsolute(relative)) throw new Error('Absolute paths are not allowed.');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path is outside the allowed directory.');
  return resolved;
}
export function isSafeSetupKey(provided: string) {
  return Boolean(config.setupKey && safeEqual(provided, config.setupKey));
}
export function securityCookieOptions() {
  return { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict' as const, path: '/', maxAge: config.sessionDays * 24 * 60 * 60 };
}
