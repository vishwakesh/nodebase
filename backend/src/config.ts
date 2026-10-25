import 'dotenv/config';
import path from 'node:path';

const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 3001, 1, 65535),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  setupKey: process.env.NODEBASE_SETUP_KEY ?? '',
  encryptionKey: process.env.NODEBASE_ENCRYPTION_KEY ?? '',
  storageRoot: path.resolve(process.env.NODEBASE_STORAGE_ROOT ?? '/srv/nodebase/data'),
  databasePath: path.resolve(process.env.NODEBASE_DATABASE_PATH ?? path.join(process.env.NODEBASE_STORAGE_ROOT ?? '/srv/nodebase/data', 'db', 'nodebase.sqlite')),
  botRoot: path.resolve(process.env.NODEBASE_BOT_ROOT ?? path.join(process.env.NODEBASE_STORAGE_ROOT ?? '/srv/nodebase/data', 'bots')),
  blobRoot: path.resolve(process.env.NODEBASE_BLOB_ROOT ?? path.join(process.env.NODEBASE_STORAGE_ROOT ?? '/srv/nodebase/data', 'file-blobs')),
  backupRoot: path.resolve(process.env.NODEBASE_BACKUP_ROOT ?? path.join(process.env.NODEBASE_STORAGE_ROOT ?? '/srv/nodebase/data', 'backups')),
  maxFileBytes: int(process.env.NODEBASE_MAX_FILE_BYTES, 1_073_741_824, 1_048_576, 20_000_000_000),
  maxStorageBytes: int(process.env.NODEBASE_MAX_STORAGE_BYTES, 107_374_182_400, 1_048_576, Number.MAX_SAFE_INTEGER),
  maxBotUploadBytes: int(process.env.NODEBASE_MAX_BOT_ZIP_BYTES, 262_144_000, 1_048_576, 2_000_000_000),
  sessionDays: int(process.env.NODEBASE_SESSION_DAYS, 7, 1, 90),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? '',
  runnerUrl: (process.env.RUNNER_URL ?? '').replace(/\/$/, ''),
  runnerToken: process.env.RUNNER_TOKEN ?? '',
  staticDir: path.resolve(process.env.NODEBASE_STATIC_DIR ?? path.join(process.cwd(), 'frontend', 'dist')),
};

export function encryptionKeyBytes(): Buffer | null {
  if (!config.encryptionKey) return null;
  try {
    const key = Buffer.from(config.encryptionKey, 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}
