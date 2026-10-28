/**
 * Decode a QR *image* back into its payload.
 *
 * Why this matters: `qr_code` in a bridge response is often a PNG data-URL, and
 * what it encodes is not guaranteed to be a UPI intent. On live PhonePe
 * "redirect" mode it is just the hosted checkout URL — so scanning it opens the
 * gateway page rather than a payment app. We decode it to know which one we got
 * instead of showing a "scan to pay" QR that silently does the wrong thing.
 *
 * Decoding is deliberately dumb-but-stubborn: gateway PNGs are tiny (320px),
 * have no quiet zone, and land on non-integer module sizes, which trips up
 * naive readers. So we try the image as-is, then re-sample it onto an ideal
 * module grid (finders validated) and upscale before retrying.
 */

import { createHash } from 'node:crypto';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library';

export interface QrDecodeResult {
  payload: string;
  kind: 'upi-intent' | 'checkout-url' | 'text';
  /** How the payload was recovered, for the diagnostics tab. */
  method: string;
}

const cache = new Map<string, QrDecodeResult | null>();

/** Accepts a data URL or bare base64 PNG. Returns null for anything else. */
export function parseImageDataUrl(value: string): Buffer | null {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,([\s\S]+)$/i.exec(value.trim());
  if (match?.[2]) {
    try {
      return Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100) {
    try {
      const buffer = Buffer.from(value.replace(/\s+/g, ''), 'base64');
      // PNG magic number
      if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return buffer;
    } catch {
      return null;
    }
  }
  return null;
}

function classify(payload: string): QrDecodeResult['kind'] {
  const value = payload.trim();
  if (/^(upi|ppe|tez|paytmmp|paytm|bhim):/i.test(value)) return 'upi-intent';
  if (/^https?:\/\//i.test(value)) return 'checkout-url';
  return 'text';
}

function decodeWithZxing(luma: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luma, width, height)));
    const reader = new QRCodeReader();
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]]);
    return reader.decode(bitmap, hints as Parameters<QRCodeReader['decode']>[1]).getText();
  } catch {
    return null;
  }
}

function decodeWithJsQr(rgba: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    const decode = (jsQRModule as unknown as { default?: typeof jsQRModule }).default ?? jsQRModule;
    const fn = decode as unknown as (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options: { inversionAttempts: string },
    ) => { data: string } | null;
    const result = fn(rgba, width, height, { inversionAttempts: 'attemptBoth' });
    return result ? result.data : null;
  } catch {
    return null;
  }
}

function luminance(png: PNG): Uint8ClampedArray {
  const out = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const offset = i * 4;
    out[i] = png.data[offset]! * 0.299 + png.data[offset + 1]! * 0.587 + png.data[offset + 2]! * 0.114;
  }
  return out;
}

function isFinderPattern(grid: Uint8Array, n: number, ox: number, oy: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const edge = x === 0 || x === 6 || y === 0 || y === 6;
      const inner = x === 1 || x === 5 || y === 1 || y === 5;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      const expected = edge || core ? 1 : inner ? 0 : 0;
      if (grid[(oy + y) * n + (ox + x)] !== expected) return false;
    }
  }
  return true;
}

/**
 * Re-sample the dark bounding box onto a candidate module grid and rebuild a
 * clean, upscaled image with a proper quiet zone.
 */
function resample(png: PNG, modules: number): { luma: Uint8ClampedArray; size: number } | null {
  const dark = (x: number, y: number): boolean => {
    const offset = (y * png.width + x) * 4;
    const value = png.data[offset]! * 0.299 + png.data[offset + 1]! * 0.587 + png.data[offset + 2]! * 0.114;
    return value < 128;
  };

  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!dark(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  if (spanX < modules * 2 || spanY < modules * 2) return null;

  const grid = new Uint8Array(modules * modules);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const px = Math.min(png.width - 1, Math.round(minX + ((x + 0.5) * spanX) / modules));
      const py = Math.min(png.height - 1, Math.round(minY + ((y + 0.5) * spanY) / modules));
      grid[y * modules + x] = dark(px, py) ? 1 : 0;
    }
  }

  if (
    !isFinderPattern(grid, modules, 0, 0) ||
    !isFinderPattern(grid, modules, modules - 7, 0) ||
    !isFinderPattern(grid, modules, 0, modules - 7)
  ) {
    return null;
  }

  const scale = 8;
  const pad = 4 * scale;
  const size = modules * scale + pad * 2;
  const luma = new Uint8ClampedArray(size * size).fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (grid[y * modules + x] !== 1) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          luma[(pad + y * scale + dy) * size + (pad + x * scale + dx)] = 0;
        }
      }
    }
  }
  return { luma, size };
}

export function decodeQrImage(image: Buffer): QrDecodeResult | null {
  const hash = createHash('sha256').update(image).digest('hex');
  if (cache.has(hash)) return cache.get(hash) ?? null;

  const remember = (result: QrDecodeResult | null): QrDecodeResult | null => {
    cache.set(hash, result);
    if (cache.size > 200) cache.clear();
    return result;
  };

  let png: PNG;
  try {
    png = PNG.sync.read(image);
  } catch {
    return remember(null);
  }
  if (!png.width || !png.height) return remember(null);

  const rgba = new Uint8ClampedArray(png.data);
  const luma = luminance(png);

  // 1. straight read
  let payload = decodeWithZxing(luma, png.width, png.height) ?? decodeWithJsQr(rgba, png.width, png.height);
  if (payload) return remember({ payload, kind: classify(payload), method: 'direct' });

  // 2. rebuild on an ideal module grid (21..177 by 4 = QR versions 1..40)
  for (let modules = 21; modules <= 177; modules += 4) {
    const rebuilt = resample(png, modules);
    if (!rebuilt) continue;
    payload = decodeWithZxing(rebuilt.luma, rebuilt.size, rebuilt.size);
    if (!payload) continue;
    return remember({
      payload,
      kind: classify(payload),
      method: `resampled (${modules}x${modules} modules)`,
    });
  }

  return remember(null);
}

export function decodeQrDataUrl(dataUrl: string): QrDecodeResult | null {
  const image = parseImageDataUrl(dataUrl);
  if (!image) return null;
  return decodeQrImage(image);
}
