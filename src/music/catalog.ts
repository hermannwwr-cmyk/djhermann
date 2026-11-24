/** Track metadata for the built-in songs: available without rendering anything. Pure. */
import type { TrackMeta } from '../core/types';
import type { SongDef } from './render';
import { SONGS } from './songs';
import { FIRST_BEAT_SEC, buildSections, trackDurationSec } from './timeline';

export const ARTIST = 'DJ Hermann Originals';

export function metaOf(song: SongDef): TrackMeta {
  return {
    id: song.id,
    title: song.title,
    artist: ARTIST,
    source: 'builtin',
    durationSec: trackDurationSec(song.bpm),
    grid: { bpm: song.bpm, firstBeatSec: FIRST_BEAT_SEC },
    key: song.key,
    sections: buildSections(),
    art: { ...song.art },
  };
}

export const songById = (id: string): SongDef | undefined => SONGS.find((s) => s.id === id);

export const buildCatalog = (): TrackMeta[] => SONGS.map(metaOf);
