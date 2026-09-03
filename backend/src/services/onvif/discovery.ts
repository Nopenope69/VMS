import { Discovery } from 'onvif';
import onvifManager from './client';
import { detectVendorFromManufacturer } from './quirks';

export interface DiscoveredCamera {
  ipAddress: string;
  onvifPort: number;
  xAddrs: string[];
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  serialNumber?: string;
  suggestedQuirks: string[];
}

export class OnvifDiscoveryService {
  /**
   * Discovers ONVIF devices on the local LAN using WS-Discovery multicast.
   */
  static async discoverMulticast(timeoutMs = 5000): Promise<DiscoveredCamera[]> {
    return new Promise((resolve) => {
      const devicesMap = new Map<string, DiscoveredCamera>();

      try {
        Discovery.probe({ timeout: timeoutMs }, (err?: Error, cams?: any[]) => {
          if (err || !Array.isArray(cams)) {
            resolve([]);
            return;
          }

          for (const cam of cams) {
            const xAddr = cam.xaddrs?.[0] || '';
            const match = xAddr.match(/https?:\/\/([^/:]+)(?::(\d+))?/i);
            const ip = match ? match[1] : cam.hostname;
            const port = match && match[2] ? parseInt(match[2], 10) : cam.port || 80;

            if (ip && !devicesMap.has(`${ip}:${port}`)) {
              devicesMap.set(`${ip}:${port}`, {
                ipAddress: ip,
                onvifPort: port,
                xAddrs: cam.xaddrs || [],
                suggestedQuirks: [],
              });
            }
          }

          resolve(Array.from(devicesMap.values()));
        });
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Probes a specific IP address and port to verify ONVIF support and extract device metadata.
   */
  static async probeIp(
    ip: string,
    port = 80,
    username?: string,
    password?: string
  ): Promise<DiscoveredCamera | null> {
    try {
      const info = await onvifManager.getDeviceInformation({
        hostname: ip,
        port,
        username,
        password,
      });

      const quirks = detectVendorFromManufacturer(info.manufacturer, info.model);

      return {
        ipAddress: ip,
        onvifPort: port,
        xAddrs: [`http://${ip}:${port}/onvif/device_service`],
        manufacturer: info.manufacturer,
        model: info.model,
        firmwareVersion: info.firmwareVersion,
        serialNumber: info.serialNumber,
        suggestedQuirks: quirks,
      };
    } catch {
      return null;
    }
  }

  /**
   * Subnet scan constrained strictly to RFC1918 private subnets, rate-limited and admin authorized.
   */
  static async scanSubnet(
    subnetCidr: string,
    port = 80,
    concurrency = 10
  ): Promise<DiscoveredCamera[]> {
    // Validate RFC1918
    const isRfc1918 =
      subnetCidr.startsWith('10.') ||
      subnetCidr.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(subnetCidr);

    if (!isRfc1918) {
      throw new Error('Subnet scan is strictly restricted to RFC1918 private network ranges (10.x, 172.16-31.x, 192.168.x)');
    }

    // For /24 range, parse base IP
    const baseMatch = subnetCidr.match(/^(\d+\.\d+\.\d+)\.\d+(?:\/24)?$/);
    if (!baseMatch) {
      throw new Error('Only /24 IPv4 subnets are permitted for scanning (e.g. 192.168.1.0/24)');
    }

    const baseIp = baseMatch[1];
    const results: DiscoveredCamera[] = [];

    // Rate-limited chunked scan (1 to 254)
    const ips: string[] = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${baseIp}.${i}`);
    }

    for (let i = 0; i < ips.length; i += concurrency) {
      const chunk = ips.slice(i, i + concurrency);
      const chunkPromises = chunk.map((ip) => this.probeIp(ip, port));
      const chunkResults = await Promise.all(chunkPromises);

      for (const res of chunkResults) {
        if (res) {
          results.push(res);
        }
      }
    }

    return results;
  }
}
