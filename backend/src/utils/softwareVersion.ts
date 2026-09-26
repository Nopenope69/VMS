import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';

export interface SoftwareVersionInfo {
  version: string;
  /** Where the version came from, so callers never present a guess as fact. */
  source: 'OTA_VERSION_FILE' | 'BUILD_PACKAGE_JSON' | 'UNKNOWN';
}

const DEFAULT_OTA_VERSION_FILE = '/opt/vigilone/version.json';

/**
 * Installed software version: the OTA-managed version file if present (what OTA actually
 * installed), otherwise the version declared by the running build's package.json. Never a literal.
 */
export function getInstalledSoftwareVersion(
  versionFilePath: string = process.env.VIGILONE_VERSION_FILE || DEFAULT_OTA_VERSION_FILE
): SoftwareVersionInfo {
  try {
    if (fs.existsSync(versionFilePath)) {
      const data = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
      if (typeof data.version === 'string' && data.version.length > 0) {
        return { version: data.version, source: 'OTA_VERSION_FILE' };
      }
    }
  } catch {
    // fall through to the build version
  }
  for (const candidate of [path.resolve(__dirname, '../../package.json'), path.resolve(__dirname, '../package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.name === 'vigilone-backend' && typeof pkg.version === 'string') {
        return { version: pkg.version, source: 'BUILD_PACKAGE_JSON' };
      }
    } catch {
      // try next candidate
    }
  }
  return { version: 'UNKNOWN', source: 'UNKNOWN' };
}

/** Prisma client version compiled into this build (runtime value, not a literal). */
export function getPrismaClientVersion(): string {
  return Prisma.prismaVersion.client;
}
