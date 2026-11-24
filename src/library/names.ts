/**
 * Title, artist, cover art and id for a track imported from a file.
 */
import { hashString } from '../core/math';
import type { TrackArt } from '../core/types';

export const UNKNOWN_ARTIST = 'My Music';

/** Collapse whitespace and trim stray separators. */
const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.]+|[\s\-–—]+$/g, '')
    .trim();

/**
 * Title and artist from a file name: "Artist - Title.mp3" (also with an en/em dash), underscores
 * become spaces, the extension and a leading track number ("01 ", "01. ", "1-") are dropped.
 * Without a separator the whole name is the title and the artist is "My Music".
 */
export function parseFileName(fileName: string): { title: string; artist: string } {
  let base = fileName.replace(/^.*[\\/]/, ''); // a path, just in case
  base = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // a leading track number: "01 Title", "01. Title", "01 - Artist - Title"
  base = base.replace(/^\d{1,3}(\s*[.\-–—)]\s*|\s+)(?=\S)/, '');
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  let artist = m ? tidy(m[1]) : '';
  let title = m ? tidy(m[2]) : tidy(base);
  if (!title) {
    title = artist || 'Untitled track';
    artist = '';
  }
  return { title, artist: artist || UNKNOWN_ARTIST };
}

/** Cover art derived from the title: two hues 90-200 degrees apart and a seed. */
export function artFor(title: string): TrackArt {
  const h = hashString(title.toLowerCase());
  const hueA = h % 360;
  const hueB = (hueA + 90 + ((h >>> 9) % 111)) % 360;
  return { hueA, hueB, seed: h };
}

/** A fresh id for a user track. */
export function newTrackId(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `user-${now.toString(36)}-${rand}`;
}
