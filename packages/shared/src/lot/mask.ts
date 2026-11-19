/**
 * Masks a bidder's display name for public bid history: "olena_7" → "o***7".
 * Uses code points, so Cyrillic and emoji are not split in half.
 */
export const maskName = (displayName: string): string => {
  const chars = Array.from(displayName.trim());
  const first = chars[0];
  const last = chars[chars.length - 1];
  if (first === undefined || last === undefined) return '***';
  return `${first.toLowerCase()}***${last.toLowerCase()}`;
};
