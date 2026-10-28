import QRCode from 'qrcode';

/**
 * 1200 characters is a practical ceiling for a phone camera at ~300px with
 * medium error correction. Anything longer becomes an unscannable wall of dots.
 */
export const QR_MAX_LENGTH = 1200;

export function fitsInQr(value: string): boolean {
  return value.length > 0 && value.length <= QR_MAX_LENGTH;
}

export async function renderQr(value: string): Promise<string | null> {
  if (!fitsInQr(value)) return null;
  try {
    return await QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: { dark: '#0b1020ff', light: '#ffffffff' },
    });
  } catch {
    return null;
  }
}
