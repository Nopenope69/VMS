import { AdapterError, decodeJpeg } from './adapterCore';
import { Image3 } from '../anpr/imageOps';
import { Frame } from '../sdk/core';

/** Decodes an ai-adapter.v1 frame (jpeg, rgb24 or bgr24, inline_base64) into an RGB image. */
export async function decodeRequestFrame(f: { format: string; width: number; height: number; data: { kind: string; value?: string } }): Promise<Image3> {
  if (f.data.kind !== 'inline_base64' || typeof f.data.value !== 'string') throw new AdapterError('INVALID_FRAME', 'shared_memory frames are not supported; send inline_base64');
  return decodeBytes(f.format, f.width, f.height, Buffer.from(f.data.value, 'base64'));
}

/** Decodes a frame the SDK core has already taken apart (its bytes, not base64) into an RGB image. */
export function decodeFrame(f: Frame): Promise<Image3> {
  return decodeBytes(f.format, f.width, f.height, f.data);
}

async function decodeBytes(format: string, width: number, height: number, bytes: Buffer): Promise<Image3> {
  let rgb: Buffer;
  if (format === 'jpeg') rgb = await decodeJpeg(bytes, width, height);
  else {
    if (bytes.length !== width * height * 3) throw new AdapterError('INVALID_FRAME', `frame data is ${bytes.length} bytes, expected ${width * height * 3}`);
    rgb = bytes;
    if (format === 'bgr24') {
      rgb = Buffer.from(bytes);
      for (let i = 0; i < rgb.length; i += 3) {
        const t = rgb[i];
        rgb[i] = rgb[i + 2];
        rgb[i + 2] = t;
      }
    }
  }
  return { data: new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length), width, height };
}
