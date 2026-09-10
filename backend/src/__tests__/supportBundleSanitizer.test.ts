import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { ApplianceService } from "../services/system/appliance.service";

describe("Support Bundle Privacy & Archive Extraction Security", () => {
  let applianceService: ApplianceService;
  let tempBundlePath: string;
  let extractDir: string;

  beforeEach(() => {
    const mockPrisma: any = {
      applianceState: {
        findUnique: jest.fn().mockResolvedValue({
          id: "SINGLETON",
          isBootstrapped: true,
          bootstrappedAt: new Date(),
          applianceId: "test-appliance-id-4819",
          createdAt: new Date(),
        }),
      },
      camera: {
        findMany: jest.fn().mockResolvedValue([
          { id: "cam_1", recordingMode: "CONTINUOUS", effectiveRecordingMode: "CONTINUOUS" },
        ]),
      },
      storageVolume: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    applianceService = new ApplianceService(mockPrisma);
    tempBundlePath = path.join(os.tmpdir(), `test-support-bundle-${Date.now()}.tar.gz`);
    extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigilone-extracted-bundle-"));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempBundlePath)) fs.unlinkSync(tempBundlePath);
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Sanitizer Unit Filter", () => {
    it("strips JWTs, Bearer tokens, and Authorization headers", () => {
      const raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const sanitized = applianceService.sanitizeContent(raw);
      expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI");
      expect(sanitized).toContain("[SANITIZED]");
    });

    it("strips database connection strings with passwords", () => {
      const raw = "DATABASE_URL=postgresql://vigilone:super_secret_db_password_2026@postgres:5432/vigilone_db?schema=public";
      const sanitized = applianceService.sanitizeContent(raw);
      expect(sanitized).not.toContain("super_secret_db_password_2026");
      expect(sanitized).toContain("postgresql://vigilone:[SANITIZED]@");
    });

    it("strips camera RTSP passwords", () => {
      const raw = "stream_uri: rtsp://admin:CameraPassword999@192.168.1.100:554/live/ch0";
      const sanitized = applianceService.sanitizeContent(raw);
      expect(sanitized).not.toContain("CameraPassword999");
      expect(sanitized).toContain("rtsp://admin:[SANITIZED]@");
    });

    it("strips PEM private keys", () => {
      const raw = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y3m...fakekeydata...\n-----END RSA PRIVATE KEY-----";
      const sanitized = applianceService.sanitizeContent(raw);
      expect(sanitized).not.toContain("fakekeydata");
      expect(sanitized).toContain("[SANITIZED_PRIVATE_KEY]");
    });
  });

  describe("End-to-End Generated Archive Extraction & Recursive Inspection", () => {
    it("generates real .tar.gz archive and asserts all extracted files are free of forbidden secrets", async () => {
      // 1. Generate the actual .tar.gz archive
      await applianceService.generateSupportBundle(tempBundlePath);
      expect(fs.existsSync(tempBundlePath)).toBe(true);

      // 2. Extract the archive into a sandbox directory
      execSync(`tar -xzf "${tempBundlePath}" -C "${extractDir}"`);

      // 3. Helper to recursively list all files in extracted directory
      const getAllFiles = (dir: string): string[] => {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat && stat.isDirectory()) {
            results = results.concat(getAllFiles(filePath));
          } else {
            results.push(filePath);
          }
        });
        return results;
      };

      const files = getAllFiles(extractDir);
      expect(files.length).toBeGreaterThan(0);

      // 4. Recursive inspection: forbidden patterns MUST NOT exist in any file
      const forbiddenPatterns = [
        /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
        /Bearer\s+[A-Za-z0-9_.-]{12,}/, // Bearer token
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM Private keys
        /postgresql:\/\/[^:]+:[^@\[]+@/, // unredacted DB password
        /rtsp:\/\/[^:]+:[^@\[]+@/, // unredacted RTSP password
      ];

      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        for (const pattern of forbiddenPatterns) {
          expect(pattern.test(content)).toBe(false);
        }
      }

      // Verify that expected diagnostic files are present and readable
      expect(files.some((f) => f.endsWith("appliance_identity.json"))).toBe(true);
      expect(files.some((f) => f.endsWith("system_vitals.json"))).toBe(true);
      expect(files.some((f) => f.endsWith("environment_sanitized.json"))).toBe(true);

      // Verify environment_sanitized.json strictly sanitized passwords and secrets
      const envFile = files.find((f) => f.endsWith("environment_sanitized.json"));
      if (envFile) {
        const envJson = JSON.parse(fs.readFileSync(envFile, "utf8"));
        for (const [key, value] of Object.entries(envJson)) {
          if (
            key.includes("SECRET") ||
            key.includes("PASSWORD") ||
            key.includes("KEY") ||
            key.includes("DATABASE_URL")
          ) {
            expect(value).toBe("[SANITIZED]");
          }
        }
      }
    });
  });
});
