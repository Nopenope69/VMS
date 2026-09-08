import { PrismaClient, EventSeverity } from '@prisma/client';
import { NotificationAdapter, DispatchNotificationRequest } from '../incident/orchestrator/adapters/notificationAdapter';

export { DispatchNotificationRequest };

/**
 * @deprecated Use IncidentOrchestrator or NotificationAdapter directly.
 * Compatibility shim delegating to authoritative IncidentOrchestrator NotificationAdapter.
 */
export class NotificationDispatcherService {
  private prisma: PrismaClient;
  private adapter: NotificationAdapter;
  private isRunning: boolean = false;
  private workerTimer: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.adapter = new NotificationAdapter(prisma);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.workerTimer = setInterval(() => {
      this.processQueue().catch((err) =>
        console.error('[NotificationDispatcher] Worker loop error:', err)
      );
    }, 5000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  public async enqueueAlarmNotifications(req: DispatchNotificationRequest): Promise<number> {
    return this.adapter.enqueueAlarmNotifications(req);
  }

  public async processQueue(): Promise<void> {
    await this.adapter.processQueue();
  }

  public async dispatchToAdapter(channel: any, payload: any): Promise<{ success: boolean; statusCode?: number }> {
    return this.adapter.dispatchToAdapter(channel, payload);
  }
}

export default NotificationDispatcherService;
