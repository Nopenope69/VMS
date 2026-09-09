import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LAN_IP: z.string().default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .default('postgresql://vigilone:vigilone_dev_secret_2026@localhost:5432/vigilone_db?schema=public'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long')
    .default('vigilone_dev_jwt_signing_key_32bytes_min!'),
  SETUP_TOKEN: z.string().default('vigilone_dev_setup_token_99182'),
  INTERNAL_API_SECRET: z.string().default('vigilone_internal_secret_token_98234'),
  MANAGEMENT_IP: z.string().default('127.0.0.1'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  MEDIAMTX_API_URL: z.string().default('http://mediamtx:9997'),
  COTURN_SECRET: z.string().default('vigilone_turn_secret_dev_38921'),
  COTURN_HOST: z.string().default('turn.vigilone.internal'),
  COTURN_PORT: z.coerce.number().default(3478),
  METRICS_AUTH_TOKEN: z.string().optional(),
  RECORDINGS_DIR: z.string().default('/recordings'),
  EXPORTS_DIR: z.string().default('/recordings/exports'),
  RECORD_SEGMENT_DURATION: z.string().default('10m'),
  RECORD_PART_DURATION: z.string().default('1s'),
});

function resolveEncryptionKey(rawKey?: string, isProd?: boolean): string {
  if (rawKey && rawKey.trim().length > 0) {
    const keyBuf = Buffer.from(rawKey, 'base64');
    if (keyBuf.length === 32) {
      return rawKey;
    }
  }

  // In production, check /etc/vigilone/appliance.key
  const applianceKeyPath = '/etc/vigilone/appliance.key';
  if (fs.existsSync(applianceKeyPath)) {
    try {
      const fileKey = fs.readFileSync(applianceKeyPath, 'utf8').trim();
      const buf = Buffer.from(fileKey, 'base64');
      if (buf.length === 32) {
        return fileKey;
      }
    } catch {
      // ignore
    }
  }

  if (isProd) {
    throw new Error(
      'FATAL: CREDENTIAL_ENCRYPTION_KEY is required in production! Ensure a 32-byte base64 key is provided via env or at /etc/vigilone/appliance.key'
    );
  }

  // Fallback dev key (32 bytes base64)
  return 'eGlhOHBqa2w4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=';
}

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.format();
    throw new Error(`Invalid environment configuration: ${JSON.stringify(errors, null, 2)}`);
  }

  const isProd = parsed.data.NODE_ENV === 'production';

  // Fail-fast checks in production
  if (isProd) {
    if (parsed.data.JWT_SECRET.includes('change_me') || parsed.data.JWT_SECRET.includes('vigilone_dev')) {
      throw new Error('FATAL: Production mode detected with default or insecure JWT_SECRET! Halting startup.');
    }
    if (parsed.data.SETUP_TOKEN.includes('change_me') || parsed.data.SETUP_TOKEN.includes('vigilone_dev')) {
      throw new Error('FATAL: Production mode detected with default or insecure SETUP_TOKEN! Halting startup.');
    }
    if (parsed.data.DATABASE_URL.includes('change_me') || parsed.data.DATABASE_URL.includes('vigilone_dev')) {
      throw new Error('FATAL: Production mode detected with default database credentials! Halting startup.');
    }
    if (
      parsed.data.INTERNAL_API_SECRET.length < 32 ||
      parsed.data.INTERNAL_API_SECRET.includes('change_me') ||
      parsed.data.INTERNAL_API_SECRET.includes('vigilone_internal') ||
      parsed.data.INTERNAL_API_SECRET.includes('vigilone_dev')
    ) {
      throw new Error(
        'FATAL: Production mode detected with default, short (<32 chars), or insecure INTERNAL_API_SECRET! Halting startup.'
      );
    }
    if (
      parsed.data.COTURN_SECRET.length < 32 ||
      parsed.data.COTURN_SECRET.includes('change_me') ||
      parsed.data.COTURN_SECRET.includes('vigilone_turn_secret_dev') ||
      parsed.data.COTURN_SECRET.includes('vigilone_dev')
    ) {
      throw new Error(
        'FATAL: Production mode detected with default, short (<32 chars), or insecure COTURN_SECRET! Halting startup.'
      );
    }
  }

  const resolvedEncryptionKey = resolveEncryptionKey(parsed.data.CREDENTIAL_ENCRYPTION_KEY, isProd);

  return {
    ...parsed.data,
    CREDENTIAL_ENCRYPTION_KEY: resolvedEncryptionKey,
    isProduction: isProd,
  };
}

export const config = loadConfig();
export default config;
