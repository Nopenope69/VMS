import { GridLayoutType, LayoutVisibility } from '@prisma/client';
import { assertTenantBoundary } from '../services/rbac/permissions';

describe('LayoutManager - Multi-Tenant Layout Boundaries & Visibility', () => {
  let mockPrisma: any;
  let layoutStore: any[] = [];

  beforeEach(() => {
    layoutStore = [];
    mockPrisma = {
      layout: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            layoutStore.filter((l) => {
              if (l.tenantId !== where.tenantId) return false;
              // Check OR visibility
              const isShared = l.visibility === LayoutVisibility.TENANT_SHARED;
              const isOwner = where.OR?.some((cond: any) => cond.userId === l.userId);
              return isShared || isOwner;
            })
          );
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(layoutStore.find((l) => l.id === where.id) || null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const l = { id: `layout_${layoutStore.length + 1}`, ...data };
          layoutStore.push(l);
          return Promise.resolve(l);
        }),
      },
    };
  });

  it('should enforce strict tenant boundary and prevent cross-tenant layout access', () => {
    expect(() => {
      assertTenantBoundary('tenant_ALPHA', 'tenant_BRAVO');
    }).toThrow(/Forbidden: Access to resources belonging to another tenant is strictly prohibited/);
  });

  it('should filter layouts so private layouts are visible only to their owner while tenant-shared layouts are visible to all operators', async () => {
    // Layout 1: User 1 private
    await mockPrisma.layout.create({
      data: {
        tenantId: 'tenant_01',
        userId: 'user_01',
        name: 'User 1 Private Quad',
        gridType: GridLayoutType.GRID_2X2,
        visibility: LayoutVisibility.PRIVATE,
      },
    });

    // Layout 2: User 2 private
    await mockPrisma.layout.create({
      data: {
        tenantId: 'tenant_01',
        userId: 'user_02',
        name: 'User 2 Private 9-Way',
        gridType: GridLayoutType.GRID_3X3,
        visibility: LayoutVisibility.PRIVATE,
      },
    });

    // Layout 3: Shared with entire tenant
    await mockPrisma.layout.create({
      data: {
        tenantId: 'tenant_01',
        userId: 'user_01',
        name: 'Control Room Shared 1+5',
        gridType: GridLayoutType.GRID_1_PLUS_5,
        visibility: LayoutVisibility.TENANT_SHARED,
      },
    });

    // Query as User 1
    const user1Layouts = await mockPrisma.layout.findMany({
      where: {
        tenantId: 'tenant_01',
        OR: [{ visibility: LayoutVisibility.TENANT_SHARED }, { userId: 'user_01' }],
      },
    });

    expect(user1Layouts).toHaveLength(2);
    expect(user1Layouts.map((l: any) => l.name)).toContain('User 1 Private Quad');
    expect(user1Layouts.map((l: any) => l.name)).toContain('Control Room Shared 1+5');
    expect(user1Layouts.map((l: any) => l.name)).not.toContain('User 2 Private 9-Way');
  });
});
