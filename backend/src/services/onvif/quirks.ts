export interface VendorQuirk {
  id: string;
  name: string;
  description: string;
  adjustRtspUrl?: (url: string, isSubstream?: boolean) => string;
  adjustSoapHeaders?: (headers: Record<string, any>) => Record<string, any>;
}

export const KNOWN_QUIRKS: Record<string, VendorQuirk> = {
  HIKVISION_SECONDARY_STREAM: {
    id: 'HIKVISION_SECONDARY_STREAM',
    name: 'Hikvision Channel Suffix',
    description: 'Directs substream to /Streaming/Channels/102',
    adjustRtspUrl: (url: string, isSubstream = false) => {
      if (!isSubstream) return url;
      // If Hikvision URL matches standard pattern, ensure channel 102
      if (url.includes('/Streaming/Channels/101')) {
        return url.replace('/Streaming/Channels/101', '/Streaming/Channels/102');
      }
      return url;
    },
  },
  DAHUA_SUBSTREAM: {
    id: 'DAHUA_SUBSTREAM',
    name: 'Dahua Subtype Parameter',
    description: 'Appends subtype=1 for Dahua substreams',
    adjustRtspUrl: (url: string, isSubstream = false) => {
      if (!isSubstream) return url;
      if (url.includes('/cam/realmonitor') && !url.includes('subtype=')) {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}subtype=1`;
      }
      return url;
    },
  },
  CP_PLUS_NVR_CHANNEL: {
    id: 'CP_PLUS_NVR_CHANNEL',
    name: 'CP Plus NVR PoE Channel Map',
    description: 'Maps CP Plus NVR internal PoE switch channels',
    adjustRtspUrl: (url: string) => url,
  },
};

export function detectVendorFromManufacturer(manufacturer?: string, model?: string): string[] {
  const quirks: string[] = [];
  const mf = (manufacturer || '').toLowerCase();
  const md = (model || '').toLowerCase();

  if (mf.includes('hikvision') || md.includes('ds-2cd')) {
    quirks.push('HIKVISION_SECONDARY_STREAM');
  } else if (mf.includes('dahua') || md.includes('ipc-hdw') || md.includes('dh-')) {
    quirks.push('DAHUA_SUBSTREAM');
  } else if (mf.includes('cp plus') || mf.includes('cpplus') || md.includes('cp-')) {
    quirks.push('CP_PLUS_NVR_CHANNEL');
    quirks.push('DAHUA_SUBSTREAM'); // CP Plus Orange/Indigo often share Dahua protocol
  }

  return quirks;
}
