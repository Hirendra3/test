/** Host of a URL, or the raw string when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
