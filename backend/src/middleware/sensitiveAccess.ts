import { Request, Response } from 'express';
import { Role } from '@prisma/client';
import prisma from '../config/database';
import { hasPermission, Permission } from '../services/rbac/permissions';
import { requirePurpose } from '../services/privacy/dataProtection.service';

const plateGate = requirePurpose(prisma, 'PLATE');
const personGate = requirePurpose(prisma, 'BIOMETRIC');

/**
 * Person tracks need CROP_PERSON_QUERY and plate data needs PLATE_DATA_QUERY, each with a declared, allowed purpose
 * (requirePurpose). Sends the refusal itself and returns false when refused; on success req.dataAccess is set, so the
 * caller can audit with recordSensitiveQuery.
 */
export async function sensitiveAccess(req: Request, res: Response, kind: 'person' | 'plate'): Promise<boolean> {
  const permission = kind === 'person' ? Permission.CROP_PERSON_QUERY : Permission.PLATE_DATA_QUERY;
  if (!hasPermission(req.user!.role as Role, permission)) {
    res.status(403).json({ error: `Forbidden: ${kind === 'person' ? 'person tracks' : 'plate data'} need the '${permission}' permission`, code: kind === 'person' ? 'PERSON_TRACK_FORBIDDEN' : 'PLATE_DATA_FORBIDDEN' });
    return false;
  }
  let passed = false;
  await (kind === 'person' ? personGate : plateGate)(req, res, () => {
    passed = true;
  });
  return passed;
}
