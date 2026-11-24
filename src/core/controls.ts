import type { ControlId, DeckControl, DeckId, PanelId } from './types';

/** Controls that live on a deck panel; everything else on a deck lives on the mixer panel. */
const DECK_PANEL_CONTROLS: ReadonlySet<DeckControl> = new Set<DeckControl>([
  'play',
  'cue',
  'sync',
  'tempo',
  'nudge-',
  'nudge+',
  'platter',
]);

export const controlId = (deck: DeckId, control: DeckControl): ControlId => `${deck}.${control}`;

export function parseControl(id: ControlId): { deck: DeckId; control: DeckControl } | null {
  if (id === 'xfader') return null;
  const dot = id.indexOf('.');
  return { deck: id.slice(0, dot) as DeckId, control: id.slice(dot + 1) as DeckControl };
}

/**
 * Which console panel a control is on, or null when it is always visible (the crossfader).
 * Deck panels hold the platter, transport and tempo; the mixer panel holds EQ, filter, fader, echo.
 */
export function panelOf(id: ControlId): PanelId | null {
  const c = parseControl(id);
  if (!c) return null;
  if (DECK_PANEL_CONTROLS.has(c.control)) return c.deck === 'A' ? 'deckA' : 'deckB';
  return 'mixer';
}

export const deckPanel = (deck: DeckId): PanelId => (deck === 'A' ? 'deckA' : 'deckB');
