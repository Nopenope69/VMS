import { AdapterError, decodeJpeg } from './adapterCore';
import { Image3 } from '../anpr/imageOps';

/** Decodes an ai-adapter.v1 frame (jpeg, rgb24 or bgr24, inline_base64) into an RGB image. */
export async function decodeRequestFrame(f: { format: string; width: number; height: number; data: { kind: string; value?: string } }): Promise<Image3> {
  if (f.data.kind !== 'inline_base64' || typeof f.data.value !== 'string') throw new AdapterError('INVALID_FRAME', 'shared_memory frames are not supported; send inline_base64');
  const bytes = Buffer.from(f.data.value, 'base64');
  let rgb: Buffer;
  if (f.format === 'jpeg') rgb = await decodeJpeg(bytes, f.width, f.height);
  else {
    if (bytes.length !== f.width * f.height * 3) throw new AdapterError('INVALID_FRAME', `frame data is ${bytes.length} bytes, expected ${f.width * f.height * 3}`);
    rgb = bytes;
    if (f.format === 'bgr24') {
      rgb = Buffer.from(bytes);
      for (let i = 0; i < rgb.length; i += 3) {
        const t = rgb[i];
        rgb[i] = rgb[i + 2];
        rgb[i + 2] = t;
      }
    }
  }
  return { data: new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length), width: f.width, height: f.height };
}
