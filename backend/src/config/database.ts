import { PrismaClient } from '@prisma/client';
import { setting } from './settings';

declare global {
  // eslint-disable-next-line no-var
  var __vigilonePrismaSingleton__: PrismaClient | undefined;
}

/**
 * Authoritative Prisma Client singleton for VigilOne VMS.
 *
 * Prevents PostgreSQL connection pool exhaustion (C-006).
 * Ensures a single shared client instance across all routes, middleware,
 * and background services.
 */
export const prisma: PrismaClient =
  global.__vigilonePrismaSingleton__ ||
  new PrismaClient({
    log:
      setting('NODE_ENV') === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (setting('NODE_ENV') !== 'production') {
  global.__vigilonePrismaSingleton__ = prisma;
}

export default prisma;
