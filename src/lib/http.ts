/** Small fetch helpers with hard timeouts and a body-size ceiling. */

export class HttpError extends Error {
  readonly status: number | null;
  readonly code: 'timeout' | 'network' | 'http' | 'too-large';

  constructor(code: HttpError['code'], message: string, status: number | null = null) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
  }
}

export const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: init.redirect ?? 'follow',
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new HttpError('timeout', `Request to ${new URL(url).host} timed out after ${timeoutMs} ms.`);
    }
    throw new HttpError('network', `Could not reach ${new URL(url).host}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function readTextLimited(response: Response, maxBytes = 512 * 1024): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new HttpError('too-large', `Response is ${declared} bytes, above the ${maxBytes} byte limit.`, response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError('too-large', `Response exceeded the ${maxBytes} byte limit.`, response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await readTextLimited(response, 1024 * 1024).catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
