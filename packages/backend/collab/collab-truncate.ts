/**
 * Truncation that cannot split a character (R7 / P2-14).
 *
 * `String.prototype.slice` counts UTF-16 code UNITS, and everything outside the
 * BMP — emoji, the CJK extension blocks where rarer 汉字 live — is two of them.
 * Cutting between the pair leaves a lone surrogate: a replacement glyph in the
 * UI, and a byte sequence that some providers reject outright. The room is
 * full of exactly this text (emoji reactions, avatars, names), and four places
 * truncated it: say bodies, judgement-window lines, quote excerpts and halt
 * reasons.
 *
 * Backing off ONE unit is enough: a surrogate pair is exactly two units, so if
 * the cut landed inside one, the character before the boundary is a high
 * surrogate and dropping it removes the whole pair. Never adds characters.
 */
export function truncateAtCodePoint(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text
  const code = text.charCodeAt(maxUnits - 1)
  // A high surrogate at the boundary means its partner is the unit we cut off.
  const safe = code >= 0xd800 && code <= 0xdbff ? maxUnits - 1 : maxUnits
  return text.slice(0, safe)
}
