import { AuthRateLimiter } from "../middleware/rateLimiter";
import authRoutes, { setAuthPrismaClient } from "../routes/auth.routes";

function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}, body: any = {}) {
  const req: any = {
    method,
    url,
    originalUrl: url,
    headers: { ...headers },
    body,
    ip: "127.0.0.1",
  };

  let statusCode = 200;

  const res: any = {
    statusCode: 200,
    status: jest.fn().mockImplementation((code: number) => {
      statusCode = code;
      res.statusCode = code;
      return res;
    }),
    cookie: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  };

  const execute = () =>
    new Promise<{ status: number; body: any }>((resolve) => {
      let resolved = false;
      const done = (status: number, body: any) => {
        if (!resolved) {
          resolved = true;
          resolve({ status, body });
        }
      };

      res.json = jest.fn().mockImplementation((data: any) => {
        done(statusCode, data);
        return res;
      });

      res.send = jest.fn().mockImplementation((data: any) => {
        done(statusCode, data);
        return res;
      });

      authRoutes(req, res, (err: any) => {
        if (err) {
          done(err.statusCode || 500, { error: err.message });
        }
      });
    });

  return { req, res, execute };
}

describe("Appliance Bootstrap & Concurrency Lifecycle", () => {
  let isBootstrappedState = false;
  let superAdminCount = 0;
  let mockPrisma: any;

  beforeEach(() => {
    AuthRateLimiter.reset();
    isBootstrappedState = false;
    superAdminCount = 0;

    mockPrisma = {
      $transaction: jest.fn(async (callback: any) => {
        return callback(mockPrisma);
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      applianceState: {
        findUnique: jest.fn().mockImplementation(() => {
          return Promise.resolve({
            id: "SINGLETON",
            isBootstrapped: isBootstrappedState,
            bootstrappedAt: isBootstrappedState ? new Date() : null,
          });
        }),
        upsert: jest.fn().mockImplementation((args: any) => {
          isBootstrappedState = args.update.isBootstrapped;
          return Promise.resolve({
            id: "SINGLETON",
            isBootstrapped: isBootstrappedState,
            bootstrappedAt: new Date(),
          });
        }),
      },
      user: {
        count: jest.fn().mockImplementation(() => Promise.resolve(superAdminCount)),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args: any) => {
          if (args.data.role === "SUPER_ADMIN") {
            superAdminCount++;
          }
          return Promise.resolve({
            id: "user_admin_01",
            email: args.data.email,
            name: args.data.name,
            role: args.data.role,
            tenantId: args.data.tenantId,
          });
        }),
      },
      tenant: {
        create: jest.fn().mockResolvedValue({
          id: "tenant_01",
          name: "Main Facility",
          sites: [{ id: "site_01", name: "Primary Site", timezone: "Asia/Kolkata" }],
        }),
      },
      license: {
        create: jest.fn().mockResolvedValue({ id: "lic_01" }),
      },
      auditEvent: {
        create: jest.fn().mockResolvedValue({ id: "audit_01" }),
      },
      userSession: {
        create: jest.fn().mockResolvedValue({ id: "session_01" }),
      },
    };

    setAuthPrismaClient(mockPrisma);
  });

  describe("GET /bootstrap/status", () => {
    it("returns strictly { isBootstrapped: false } when uninitialized", async () => {
      const { execute } = createMockReqRes("GET", "/bootstrap/status");
      const result = await execute();

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ isBootstrapped: false });
      // Invariant: Never leaks user counts, paths, or secrets before authentication
      expect(result.body.superAdminCount).toBeUndefined();
      expect(result.body.users).toBeUndefined();
      expect(result.body.secret).toBeUndefined();
    });
  });

  describe("POST /bootstrap", () => {
    it("rejects request without valid setup token header", async () => {
      const { execute } = createMockReqRes("POST", "/bootstrap", {}, {
        tenantName: "Acme HQ",
        adminEmail: "admin@acme.com",
        adminPassword: "Password123!",
      });
      const result = await execute();

      expect(result.status).toBe(401);
      expect(result.body.error).toContain("Missing or invalid setup token");
    });

    it("rejects request with invalid setup token", async () => {
      const { execute } = createMockReqRes("POST", "/bootstrap", {
        "x-setup-token": "invalid_pin_12345",
      }, {
        tenantName: "Acme HQ",
        adminEmail: "admin@acme.com",
        adminPassword: "Password123!",
      });
      const result = await execute();

      expect(result.status).toBe(401);
    });

    it("validates mandatory fields", async () => {
      const { execute } = createMockReqRes("POST", "/bootstrap", {
        "x-setup-token": "vigilone_dev_setup_token_99182",
      }, {
        tenantName: "",
        adminEmail: "",
      });
      const result = await execute();

      expect(result.status).toBe(400);
    });

    it("successfully bootstraps on valid first-run request", async () => {
      const { execute } = createMockReqRes("POST", "/bootstrap", {
        "x-setup-token": "vigilone_dev_setup_token_99182",
      }, {
        tenantName: "Acme Corp",
        adminEmail: "admin@acme.corp",
        adminPassword: "SecurePassword2026!",
        adminName: "Lead Administrator",
        siteTimezone: "Asia/Kolkata",
      });

      const result = await execute();
      expect(result.status).toBe(201);
      expect(result.body.user.email).toBe("admin@acme.corp");
      expect(result.body.user.role).toBe("SUPER_ADMIN");
      expect(result.body.token).toBeDefined();
      expect(result.body.message).toContain("Enterprise evaluation license");
    });
  });

  describe("One-Time Bootstrap Invariant & Concurrency Lock", () => {
    it("permanently returns 410 Gone once initialized", async () => {
      // 1. Initial bootstrap
      const { execute: execFirst } = createMockReqRes("POST", "/bootstrap", {
        "x-setup-token": "vigilone_dev_setup_token_99182",
      }, {
        tenantName: "Acme Corp",
        adminEmail: "admin@acme.corp",
        adminPassword: "SecurePassword2026!",
      });
      const firstResult = await execFirst();
      expect(firstResult.status).toBe(201);

      // 2. Status check now returns isBootstrapped: true
      const { execute: execStatus } = createMockReqRes("GET", "/bootstrap/status");
      const statusResult = await execStatus();
      expect(statusResult.status).toBe(200);
      expect(statusResult.body).toEqual({ isBootstrapped: true });

      AuthRateLimiter.reset();
      // 3. Second bootstrap attempt MUST fail with 410 Gone
      const { execute: execSecond } = createMockReqRes("POST", "/bootstrap", {
        "x-setup-token": "vigilone_dev_setup_token_99182",
      }, {
        tenantName: "Intruder Corp",
        adminEmail: "intruder@evil.com",
        adminPassword: "HackerPassword123!",
      });
      const secondResult = await execSecond();
      expect(secondResult.status).toBe(410);
      expect(secondResult.body.code).toBe("BOOTSTRAP_ALREADY_COMPLETED");
    });
  });
});
