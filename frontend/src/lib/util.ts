export function normalizeTitle(t: string): string {
  return t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
