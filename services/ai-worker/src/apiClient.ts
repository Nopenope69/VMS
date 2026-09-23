import http from 'http';
import https from 'https';
import { URL } from 'url';
import { NormalizedDetectionEvent } from './types';

export interface ApiClientConfig {
  baseUrl: string;
  internalSecret: string;
  timeoutMs?: number;
}

export interface IngestionResponse {
  success: boolean;
  detectionId: string;
  inferenceId: string;
}

export class AuthenticatedInternalApiClient {
  private baseUrl: string;
  private secret: string;
  private timeoutMs: number;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret = config.internalSecret;
    this.timeoutMs = config.timeoutMs || 5000;
  }

  /**
   * Submits a normalized detection event to the VigilOne backend internal ingestion endpoint.
   */
  public async submitDetection(detection: NormalizedDetectionEvent): Promise<IngestionResponse> {
    const endpoint = `${this.baseUrl}/detections`;
    const targetUrl = new URL(endpoint);
    const payload = JSON.stringify(detection);

    return new Promise((resolve, reject) => {
      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${this.secret}`,
        },
        timeout: this.timeoutMs,
      };

      const req = transport.request(options, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed as IngestionResponse);
            } else {
              reject(
                new Error(
                  `Ingestion endpoint returned status ${res.statusCode}: ${parsed.error || responseBody}`
                )
              );
            }
          } catch (err) {
            reject(new Error(`Failed to parse backend response (HTTP ${res.statusCode}): ${responseBody}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`API request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => reject(err));

      req.write(payload);
      req.end();
    });
  }
}
