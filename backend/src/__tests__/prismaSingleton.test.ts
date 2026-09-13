import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { prisma as prismaNamed } from '../config/database';

describe('Prisma Client Singleton & Connection Pool Boundary (C-006)', () => {
  it('exports an authoritative singleton PrismaClient', () => {
    expect(prisma).toBeDefined();
    expect(prismaNamed).toBe(prisma);
  });

  it('prohibits raw new PrismaClient() instantiations outside config/database.ts', () => {
    const srcDir = path.resolve(__dirname, '..');
    const sourceFiles: string[] = [];

    function walk(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') {
            walk(fullPath);
          }
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          sourceFiles.push(fullPath);
        }
      }
    }

    walk(srcDir);

    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of sourceFiles) {
      const relPath = path.relative(srcDir, file);
      // Skip the authoritative definition file
      if (relPath === path.join('config', 'database.ts')) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        // Look for `new PrismaClient`
        if (/new\s+PrismaClient\s*\(/.test(line)) {
          violations.push({
            file: relPath,
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
