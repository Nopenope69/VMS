import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';

export enum Permission {
  CAMERA_VIEW = 'CAMERA_VIEW',
  CAMERA_PTZ = 'CAMERA_PTZ',
  CAMERA_CREATE = 'CAMERA_CREATE',
  CAMERA_DELETE = 'CAMERA_DELETE',
  CAMERA_CONFIG = 'CAMERA_CONFIG',
  RECORDING_VIEW = 'RECORDING_VIEW',
  RECORDING_MANAGE = 'RECORDING_MANAGE',
  SCHEDULE_MANAGE = 'SCHEDULE_MANAGE',
  ZONE_MANAGE = 'ZONE_MANAGE',
  PTZ_MANAGE = 'PTZ_MANAGE',
  LAYOUT_MANAGE = 'LAYOUT_MANAGE',
  ALARM_MANAGE = 'ALARM_MANAGE',
  EVIDENCE_EXPORT = 'EVIDENCE_EXPORT',
  AUDIT_VIEW = 'AUDIT_VIEW',
  USER_MANAGE = 'USER_MANAGE',
  SITE_MANAGE = 'SITE_MANAGE',
  LICENSE_MANAGE = 'LICENSE_MANAGE',
  ANPR_VIEW = 'ANPR_VIEW',
  ANPR_MANAGE = 'ANPR_MANAGE',
  SEARCH_VIEW = 'SEARCH_VIEW',
  NOTIFICATION_MANAGE = 'NOTIFICATION_MANAGE',
  SYSTEM_BACKUP = 'SYSTEM_BACKUP',
  FEDERATION_VIEW = 'FEDERATION_VIEW',
  FEDERATION_MANAGE = 'FEDERATION_MANAGE',
  AUTOMATION_MANAGE = 'AUTOMATION_MANAGE',
  SPATIAL_RULES_MANAGE = 'SPATIAL_RULES_MANAGE',
  RELAY_VIEW = 'RELAY_VIEW',
  RELAY_CONTROL = 'RELAY_CONTROL',
  RELAY_ADMIN = 'RELAY_ADMIN',
  OBJECT_STORAGE_MANAGE = 'OBJECT_STORAGE_MANAGE',
  SSO_MANAGE = 'SSO_MANAGE',
  SESSION_MANAGE = 'SESSION_MANAGE',
  EVIDENCE_VIEW = 'EVIDENCE_VIEW',
  EVIDENCE_APPROVE = 'EVIDENCE_APPROVE',
  EVIDENCE_DELETE = 'EVIDENCE_DELETE',
  PRIVACY_POLICY_MANAGE = 'PRIVACY_POLICY_MANAGE',
  REDACTION_EXECUTE = 'REDACTION_EXECUTE',
  FLOORPLAN_MANAGE = 'FLOORPLAN_MANAGE',
  SPATIAL_RULE_MANAGE = 'SPATIAL_RULE_MANAGE',
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.CAMERA_CREATE,
    Permission.CAMERA_DELETE,
    Permission.CAMERA_CONFIG,
    Permission.RECORDING_VIEW,
    Permission.RECORDING_MANAGE,
    Permission.SCHEDULE_MANAGE,
    Permission.ZONE_MANAGE,
    Permission.PTZ_MANAGE,
    Permission.LAYOUT_MANAGE,
    Permission.ALARM_MANAGE,
    Permission.EVIDENCE_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.USER_MANAGE,
    Permission.SITE_MANAGE,
    Permission.LICENSE_MANAGE,
    Permission.ANPR_VIEW,
    Permission.ANPR_MANAGE,
    Permission.SEARCH_VIEW,
    Permission.NOTIFICATION_MANAGE,
    Permission.SYSTEM_BACKUP,
    Permission.FEDERATION_VIEW,
    Permission.FEDERATION_MANAGE,
    Permission.AUTOMATION_MANAGE,
    Permission.SPATIAL_RULES_MANAGE,
    Permission.RELAY_VIEW,
    Permission.RELAY_CONTROL,
    Permission.RELAY_ADMIN,
    Permission.OBJECT_STORAGE_MANAGE,
    Permission.SSO_MANAGE,
    Permission.SESSION_MANAGE,
    Permission.EVIDENCE_VIEW,
    Permission.EVIDENCE_APPROVE,
    Permission.EVIDENCE_DELETE,
    Permission.PRIVACY_POLICY_MANAGE,
    Permission.REDACTION_EXECUTE,
    Permission.FLOORPLAN_MANAGE,
    Permission.SPATIAL_RULE_MANAGE,
  ],
  TENANT_ADMIN: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.CAMERA_CREATE,
    Permission.CAMERA_DELETE,
    Permission.CAMERA_CONFIG,
    Permission.RECORDING_VIEW,
    Permission.RECORDING_MANAGE,
    Permission.SCHEDULE_MANAGE,
    Permission.ZONE_MANAGE,
    Permission.PTZ_MANAGE,
    Permission.LAYOUT_MANAGE,
    Permission.ALARM_MANAGE,
    Permission.EVIDENCE_EXPORT,
    Permission.AUDIT_VIEW,
    Permission.USER_MANAGE,
    Permission.SITE_MANAGE,
    Permission.LICENSE_MANAGE,
    Permission.ANPR_VIEW,
    Permission.ANPR_MANAGE,
    Permission.SEARCH_VIEW,
    Permission.NOTIFICATION_MANAGE,
    Permission.SYSTEM_BACKUP,
    Permission.FEDERATION_VIEW,
    Permission.FEDERATION_MANAGE,
    Permission.AUTOMATION_MANAGE,
    Permission.SPATIAL_RULES_MANAGE,
    Permission.RELAY_VIEW,
    Permission.RELAY_CONTROL,
    Permission.RELAY_ADMIN,
    Permission.OBJECT_STORAGE_MANAGE,
    Permission.SSO_MANAGE,
    Permission.SESSION_MANAGE,
    Permission.EVIDENCE_VIEW,
    Permission.EVIDENCE_APPROVE,
    Permission.EVIDENCE_DELETE,
    Permission.PRIVACY_POLICY_MANAGE,
    Permission.REDACTION_EXECUTE,
    Permission.FLOORPLAN_MANAGE,
    Permission.SPATIAL_RULE_MANAGE,
  ],
  OPERATOR: [
    Permission.CAMERA_VIEW,
    Permission.CAMERA_PTZ,
    Permission.PTZ_MANAGE,
    Permission.RECORDING_VIEW,
    Permission.RECORDING_MANAGE,
    Permission.SCHEDULE_MANAGE,
    Permission.ZONE_MANAGE,
    Permission.LAYOUT_MANAGE,
    Permission.ALARM_MANAGE,
    Permission.EVIDENCE_VIEW,
    Permission.EVIDENCE_EXPORT,
    Permission.ANPR_VIEW,
    Permission.ANPR_MANAGE,
    Permission.SEARCH_VIEW,
    Permission.NOTIFICATION_MANAGE,
    Permission.FEDERATION_VIEW,
    Permission.AUTOMATION_MANAGE,
    Permission.SPATIAL_RULES_MANAGE,
    Permission.RELAY_VIEW,
    Permission.RELAY_CONTROL,
    Permission.REDACTION_EXECUTE,
    Permission.FLOORPLAN_MANAGE,
    Permission.SPATIAL_RULE_MANAGE,
  ],
  VIEWER: [
    Permission.CAMERA_VIEW,
    Permission.RECORDING_VIEW,
    Permission.SEARCH_VIEW,
    Permission.ANPR_VIEW,
    Permission.FEDERATION_VIEW,
    Permission.RELAY_VIEW,
    Permission.EVIDENCE_VIEW,
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
