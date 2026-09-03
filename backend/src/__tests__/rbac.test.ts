import { Role } from '@prisma/client';
import { hasPermission, assertTenantBoundary, Permission } from '../services/rbac/permissions';

describe('RBAC Permissions & Object-Level Tenancy Invariant', () => {
  it('should grant SUPER_ADMIN full administrative permissions', () => {
    expect(hasPermission(Role.SUPER_ADMIN, Permission.CAMERA_CREATE)).toBe(true);
    expect(hasPermission(Role.SUPER_ADMIN, Permission.CAMERA_DELETE)).toBe(true);
    expect(hasPermission(Role.SUPER_ADMIN, Permission.USER_MANAGE)).toBe(true);
    expect(hasPermission(Role.SUPER_ADMIN, Permission.LICENSE_MANAGE)).toBe(true);
    expect(hasPermission(Role.SUPER_ADMIN, Permission.EVIDENCE_EXPORT)).toBe(true);
  });

  it('should allow OPERATOR to view and control PTZ but forbid camera deletion and user management', () => {
    expect(hasPermission(Role.OPERATOR, Permission.CAMERA_VIEW)).toBe(true);
    expect(hasPermission(Role.OPERATOR, Permission.CAMERA_PTZ)).toBe(true);
    expect(hasPermission(Role.OPERATOR, Permission.EVIDENCE_EXPORT)).toBe(true);

    expect(hasPermission(Role.OPERATOR, Permission.CAMERA_CREATE)).toBe(false);
    expect(hasPermission(Role.OPERATOR, Permission.CAMERA_DELETE)).toBe(false);
    expect(hasPermission(Role.OPERATOR, Permission.USER_MANAGE)).toBe(false);
  });

  it('should restrict VIEWER to view only', () => {
    expect(hasPermission(Role.VIEWER, Permission.CAMERA_VIEW)).toBe(true);
    expect(hasPermission(Role.VIEWER, Permission.RECORDING_VIEW)).toBe(true);

    expect(hasPermission(Role.VIEWER, Permission.CAMERA_PTZ)).toBe(false);
    expect(hasPermission(Role.VIEWER, Permission.EVIDENCE_EXPORT)).toBe(false);
    expect(hasPermission(Role.VIEWER, Permission.CAMERA_CREATE)).toBe(false);
  });

  it('should allow access when tenant IDs match', () => {
    expect(() => assertTenantBoundary('tenant_alpha', 'tenant_alpha')).not.toThrow();
  });

  it('should throw 403 when attempting cross-tenant access to foreign objects', () => {
    expect(() => assertTenantBoundary('tenant_foreign', 'tenant_caller')).toThrowError(
      /Forbidden: Access to resources belonging to another tenant/
    );
  });
});
