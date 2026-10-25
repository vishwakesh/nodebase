import path from 'node:path';

export function validateBotId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid bot identifier.');
  return id;
}
export function validateEntryPoint(entry: string) {
  return Boolean(entry && entry.length <= 240 && !entry.startsWith('/') && !entry.includes('\\') && !path.posix.isAbsolute(entry) && !entry.split('/').some(p => !p || p === '.' || p === '..'));
}
export function projectPathFor(root: string, id: string) {
  validateBotId(id);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, id, 'project');
  if (!target.startsWith(resolvedRoot + path.sep)) throw new Error('Bot workspace path rejected.');
  return target;
}
export function validateEnvironmentKey(key: string) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !key.startsWith('NB_') && !['PATH','HOME','PWD','LD_PRELOAD','NODE_OPTIONS','PYTHONPATH','PYTHONHOME'].includes(key);
}
