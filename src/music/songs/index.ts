/** The six built-in songs, in tempo order. */
import type { SongDef } from '../render';
import lanterns from './lanterns';
import satellites from './satellites';
import glasshouse from './glasshouse';
import golden from './golden';
import northbound from './northbound';
import neon from './neon';

export const SONGS: readonly SongDef[] = [lanterns, satellites, glasshouse, golden, northbound, neon];
