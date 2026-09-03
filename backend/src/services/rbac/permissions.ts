import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';

export enum Permission {
  CAMERA_VIEW = 'CAMERA_VIEW',
  CAMERA_PTZ = 'CAMERA_PTZ',
  CAMERA_CREATE = 'CAMERA_CREATE',
  CAMERA_DELETE = 'CAMERA_DELETE',
  CAMERA_CONFIG = 'CAMERA_CONFIG',
  RECORDING_VIEW = 'RECORDING_VIEW',
  EVIDENCE_EXPORT = 'EVIDENCE_EXPORT',
  AUDIT_VIEW = 'AUDIT_VIEW',
  USER_MANAGE = 'USER_MANAGE',
  SITE_MANAGE = 'SITE_MANAGE',
  LICENSE_MANAGE = 'LICENSE_MANAGE',
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.CAMERA_CREATE,
    Permission.CAMERA_DELETE,
    Permission.CAMERA_CONFIG,
    Permission.RECORDING_VIEW,
    Permission.EVIDENCE_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.USER_MANAGE,
    Permission.SITE_MANAGE,
    Permission.LICENSE_MANAGE,
  ],
  TENANT_ADMIN: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.CAMERA_CREATE,
    Permission.CAMERA_DELETE,
    Permission.CAMERA_CONFIG,
    Permission.RECORDING_VIEW,
    Permission.EVIDENCE_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.USER_MANAGE,
    Permission.SITE_MANAGE,
    Permission.LICENSE_MANAGE,
  ],
  OPERATOR: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.RECORDING_VIEW,
    Permission.EVIDENCE_EXPORT,
  ],
  VIEWER: [
    Permission.CAMERA_VIEW,
    Permission.RECORDING_VIEW,
  ],
};

/**
 * Evaluates whether a role possesses a specific fine-grained permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission);
}

/**
 * Express middleware to enforce permission-based authorization.
 */
export function authorize(requiredPermission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required' });
      return;
    }

    if (!hasPermission(user.role as Role, requiredPermission)) {
      res.status(403).json({
        error: `Forbidden: Insufficient privileges. Required permission: '${requiredPermission}'.`,
        role: user.role,
        requiredPermission,
      });
      return;
    }

    next();
  };
}

/**
 * Enforces strict object-level tenant boundary.
 * Prevents cross-tenant access regardless of whether ID was guessed or manipulated.
 */
export function assertTenantBoundary(objectTenantId: string, userTenantId: string): void {
  if (objectTenantId !== userTenantId) {
    const error: any = new Error('Forbidden: Access to resources belonging to another tenant is strictly prohibited.');
    error.statusCode = 403;
    throw error;
  }
}
