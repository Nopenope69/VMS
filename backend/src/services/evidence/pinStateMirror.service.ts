import fs from 'fs';
import path from 'path';

const DEFAULT_MIRROR_PATH = process.env.PIN_STATE_MIRROR_PATH || '/etc/vigilone/pinned_segments.state';

export interface PinRecord {
  sha256: string;
  segmentId: string;
  cameraId: string;
  pinnedAt: string;
  pinnedBy: string;
  reason?: string;
}

export interface MirrorState {
  version: 1;
  updatedAt: string;
  pins: Record<string, PinRecord>;
}

function load(filePath: string): MirrorState {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), pins: {} };
  }
}

function atomicWrite(state: MirrorState, filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath); // Rename is atomic on the same filesystem
  } catch (err: any) {
    console.warn(`[PinStateMirrorService] Warning: Failed to write pin state mirror to ${filePath}: ${err.message}`);
  }
}

export class PinStateMirrorService {
  private static mirrorPath: string = DEFAULT_MIRROR_PATH;

  public static setMirrorPath(newPath: string): void {
    this.mirrorPath = newPath;
  }

  public static getMirrorPath(): string {
    return this.mirrorPath;
  }

  public static reset(): void {
    this.mirrorPath = process.env.PIN_STATE_MIRROR_PATH || DEFAULT_MIRROR_PATH;
  }

  public static recordPin(rec: PinRecord): void {
    const state = load(this.mirrorPath);
    state.pins[rec.sha256] = rec;
    state.updatedAt = new Date().toISOString();
    atomicWrite(state, this.mirrorPath);
  }

  public static recordUnpin(sha256: string): void {
    const state = load(this.mirrorPath);
    delete state.pins[sha256];
    state.updatedAt = new Date().toISOString();
    atomicWrite(state, this.mirrorPath);
  }

  public static lookup(sha256: string): PinRecord | undefined {
    return load(this.mirrorPath).pins[sha256];
  }

  public static getAllPins(): Record<string, PinRecord> {
    return load(this.mirrorPath).pins;
  }
}

export default PinStateMirrorService;
