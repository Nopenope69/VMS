import net from 'net';
import { Discovery } from 'onvif';
import onvifManager from './client';
import { detectVendorFromManufacturer } from './quirks';

export function validateProbeIp(ip: string): void {
  if (!ip || typeof ip !== 'string') {
    throw new Error('IP address is required');
  }

  // 1. Explicit IPv6 policy: Reject all IPv6 addresses
  if (net.isIPv6(ip)) {
    throw new Error('IPv6 addresses are not supported for ONVIF camera discovery');
  }

  // 2. Validate valid IPv4 format
  if (!net.isIPv4(ip)) {
    throw new Error(`Invalid IPv4 address format: ${ip}`);
  }

  // 3. Prohibit link-local cloud metadata (169.254.0.0/16, including 169.254.169.254)
  if (ip.startsWith('169.254.')) {
    throw new Error('Access to link-local and cloud metadata addresses (169.254.x.x) is strictly prohibited');
  }

  // 4. Prohibit loopback (127.0.0.0/8)
  if (ip.startsWith('127.')) {
    throw new Error('Access to loopback addresses is prohibited');
  }

  // 5. Prohibit multicast (224.0.0.0/4), broadcast, unspecified
  if (ip === '0.0.0.0' || ip === '255.255.255.255') {
    throw new Error('Invalid destination IP');
  }
  const firstOctet = parseInt(ip.split('.')[0], 10);
  if (firstOctet >= 224) {
    throw new Error('Multicast/reserved IP addresses are prohibited');
  }

  // 6. Enforce RFC1918 private subnets for CCTV camera networks
  const isRfc1918 =
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  if (!isRfc1918) {
    throw new Error('Camera IP probes are restricted to RFC1918 private subnets (10.x, 172.16-31.x, 192.168.x)');
  }
}

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
    validateProbeIp(ip);
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
