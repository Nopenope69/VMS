import fs from 'fs';
import path from 'path';

export interface FileStat {
  size: number;
  mtime: Date;
  exists: boolean;
}

export interface StorageAdapter {
  stat(filePath: string): Promise<FileStat>;
  readFile(filePath: string): Promise<Buffer>;
  deleteFile(filePath: string): Promise<void>;
  scanDirectory(dirPath: string): Promise<string[]>;
}

export class LocalStorageAdapter implements StorageAdapter {
  async stat(filePath: string): Promise<FileStat> {
    try {
      const stats = await fs.promises.stat(filePath);
      return {
        size: stats.size,
        mtime: stats.mtime,
        exists: true,
      };
    } catch {
      return {
        size: 0,
        mtime: new Date(0),
        exists: false,
      };
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    return fs.promises.readFile(filePath);
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async scanDirectory(dirPath: string): Promise<string[]> {
    if (!fs.existsSync(dirPath)) return [];
    const files: string[] = [];

    const walk = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.mp4') || entry.name.endsWith('.fmp4'))) {
          files.push(fullPath);
        }
      }
    };

    await walk(dirPath);
    return files;
  }
}
