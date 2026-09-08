import { Request, Response, NextFunction } from 'express';
import { requireFeature } from '../middleware/license';

describe('Commercial License Entitlements Middleware (requireFeature)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  beforeEach(() => {
    mockReq = {
      licenseClaims: undefined,
      isLicenseExpired: false,
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFn = jest.fn();
  });

  it('should return 402 LICENSE_MISSING when license claims are not present', () => {
    const middleware = requireFeature('ANPR');
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'LICENSE_MISSING',
        error: expect.stringContaining('ANPR'),
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('should return 402 LICENSE_EXPIRED when license is expired', () => {
    mockReq.licenseClaims = {
      licenseId: 'lic_exp_1',
      tenantId: 'tenant_1',
      tier: 'ENTERPRISE',
      maxCameras: 32,
      features: ['ANPR', 'ADVANCED_SEARCH', 'NOTIFICATIONS'],
      issuedAt: new Date(Date.now() - 86400000 * 30).toISOString(),
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    };
    mockReq.isLicenseExpired = true;

    const middleware = requireFeature('ADVANCED_SEARCH');
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'LICENSE_EXPIRED',
        error: expect.stringContaining('ADVANCED_SEARCH'),
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('should return 403 FEATURE_NOT_ENTITLED when license does not include requested feature', () => {
    mockReq.licenseClaims = {
      licenseId: 'lic_basic_1',
      tenantId: 'tenant_1',
      tier: 'BASIC',
      maxCameras: 4,
      features: ['SCHEDULED_RECORDING'],
      issuedAt: new Date().toISOString(),
      expiresAt: null,
    };
    mockReq.isLicenseExpired = false;

    const middleware = requireFeature('ANPR');
    middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'FEATURE_NOT_ENTITLED',
        tier: 'BASIC',
        entitledFeatures: ['SCHEDULED_RECORDING'],
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('should call next() when feature is entitled and license is active', () => {
    mockReq.licenseClaims = {
      licenseId: 'lic_ent_1',
      tenantId: 'tenant_1',
      tier: 'ENTERPRISE',
      maxCameras: 64,
      features: ['ANPR', 'ADVANCED_SEARCH', 'NOTIFICATIONS', 'SYSTEM_BACKUP'],
      issuedAt: new Date().toISOString(),
      expiresAt: null,
    };
    mockReq.isLicenseExpired = false;

    const middlewareAnpr = requireFeature('ANPR');
    middlewareAnpr(mockReq as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalledTimes(1);

    const middlewareNotif = requireFeature('NOTIFICATIONS');
    middlewareNotif(mockReq as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalledTimes(2);

    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
