import { PrismaClient } from '@prisma/client';
import { VideoRedactorService } from './videoRedactor.service';

/**
 * Runs redaction jobs one at a time in the background (a redaction re-encodes video and must not
 * compete with recording for CPU). Outcomes are recorded on the job itself.
 */
export class RedactionQueue {
  private pending: string[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private prisma: PrismaClient, private redactor: VideoRedactorService) {}

  enqueue(jobId: string) {
    if (!this.pending.includes(jobId)) this.pending.push(jobId);
    void this.drain();
  }

  /** Jobs left PROCESSING by a restart are failed explicitly; they are never reported as done. */
  async recoverInterrupted(): Promise<number> {
    const r = await this.prisma.redactionJob.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'FAILED', errorCode: 'REDACTION_INTERRUPTED', error: 'the backend restarted while this job was running', completedAt: new Date() },
    });
    return r.count;
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const id = this.pending.shift()!;
        try {
          await this.redactor.executeRedactionJob(id);
        } catch {
          // The job row carries status FAILED, errorCode and message.
        }
      }
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((r) => r());
    }
  }
}
