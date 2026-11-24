import unboundedLatin from '@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2?url';
import unboundedLatinExt from '@fontsource-variable/unbounded/files/unbounded-latin-ext-wght-normal.woff2?url';
import manropeLatin from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url';
import manropeLatinExt from '@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

let loading: Promise<void> | null = null;

/**
 * Registers the two self-hosted families ("Unbounded" for display, "Manrope" for UI) and waits for
 * the Latin files, so canvas text never renders in a fallback font. Never rejects.
 */
export function loadFonts(): Promise<void> {
  if (loading) return loading;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (loading = Promise.resolve());

  const faces: [FontFace, boolean][] = [
    [new FontFace('Unbounded', `url(${unboundedLatin}) format('woff2')`, { weight: '200 900', unicodeRange: LATIN }), true],
    [new FontFace('Unbounded', `url(${unboundedLatinExt}) format('woff2')`, { weight: '200 900', unicodeRange: LATIN_EXT }), false],
    [new FontFace('Manrope', `url(${manropeLatin}) format('woff2')`, { weight: '200 800', unicodeRange: LATIN }), true],
    [new FontFace('Manrope', `url(${manropeLatinExt}) format('woff2')`, { weight: '200 800', unicodeRange: LATIN_EXT }), false],
  ];
  const eager: Promise<unknown>[] = [];
  for (const [face, now] of faces) {
    document.fonts.add(face);
    if (now) eager.push(face.load().catch((err) => console.warn('[fonts] failed to load', face.family, err)));
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2500));
  loading = Promise.race([Promise.all(eager).then(() => undefined), timeout]);
  return loading;
}
