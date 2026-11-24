/**
 * Every word the gig puts on screen: mission titles, hints, result labels, callouts and status
 * lines. Plain words, controls named as printed on the hardware (PLAY, SYNC, TEMPO, PITCH BEND,
 * LOW, FILTER, ECHO, CROSSFADER), always with the action to make.
 */
import type { DeckId } from '../../core/types';

const side = (deck: DeckId): string => (deck === 'B' ? 'right' : 'left');
const bpm1 = (bpm: number): string => bpm.toFixed(1);
const bars = (n: number): string => (n === 1 ? '1 BAR' : `${n} BARS`);

export const TEXT = {
  startSet: {
    title: 'START THE SET',
    hint: (d: DeckId) => `Press the green PLAY button on deck ${d} to start the music`,
    done: 'HERE WE GO',
  },

  startDeck: {
    title: (d: DeckId) => `START DECK ${d}`,
    /** more than a bar to go */
    ready: (d: DeckId) => `Get ready to press PLAY on deck ${d}. Wait for NOW`,
    /** k = 4, 3, 2, 1 beats until the next bar line */
    count: (d: DeckId, k: number) => `Get ready to press PLAY on deck ${d} …  ${k}`,
    now: (d: DeckId) => `NOW! Press PLAY on deck ${d}`,
    /** the other deck is not running, so there is nothing to count */
    plain: (d: DeckId) => `Press the green PLAY button on deck ${d}`,
    perfect: 'ON THE ONE',
    great: 'CLOSE TO THE ONE',
    early: 'A BIT EARLY',
    late: 'A BIT LATE',
    started: 'DECK STARTED',
    fail: 'TOO SLOW',
    rescue: (d: DeckId) => `STARTED DECK ${d} FOR YOU`,
  },

  beatmatch: {
    resultTitle: 'MATCH THE BEATS',
    syncTitle: (d: DeckId) => `SYNC DECK ${d}`,
    manualTitle: 'MATCH THE BEATS',
    sync: (d: DeckId, other: DeckId) => `Press SYNC on deck ${d} to match its speed to deck ${other}`,
    syncHold: 'Synced! The beats are together…',
    faster: (d: DeckId, from: number, to: number) =>
      `Deck ${d} is too slow. Slide its TEMPO fader down to speed it up: ${bpm1(from)} → ${bpm1(to)} BPM`,
    slower: (d: DeckId, from: number, to: number) =>
      `Deck ${d} is too fast. Slide its TEMPO fader up to slow it down: ${bpm1(from)} → ${bpm1(to)} BPM`,
    orSync: ' · SYNC also works, for fewer points',
    behind: (d: DeckId) => `Deck ${d}'s beat is late. Hold PITCH BEND + on deck ${d} until the beats line up`,
    ahead: (d: DeckId) => `Deck ${d}'s beat is early. Hold PITCH BEND − on deck ${d} until the beats line up`,
    hold: 'Let go! The beats are together. Keep it steady…',
    startFirst: (d: DeckId) => `Deck ${d} has stopped. Press its PLAY button to start it again`,
    inSync: 'IN SYNC',
    byHand: 'BY HAND',
    usedSync: 'USED SYNC',
    lockedIn: 'LOCKED IN',
    fail: 'OUT OF TIME',
    rescue: (d: DeckId) => `SYNCED DECK ${d} FOR YOU`,
  },

  crossfade: {
    title: (d: DeckId) => `FADE TO DECK ${d}`,
    cutTitle: (d: DeckId) => `CUT TO DECK ${d}`,
    faderFirst: (d: DeckId) => `First slide the volume fader of deck ${d} all the way up`,
    slide: (d: DeckId) => `Slide the CROSSFADER slowly to the ${side(d)}, all the way to deck ${d}`,
    bonusTip: (old: DeckId) => ` · Bonus: turn LOW on deck ${old} down first`,
    keepGoing: (d: DeckId) => `Keep sliding the CROSSFADER, slow and steady, all the way to deck ${d}`,
    cut: (d: DeckId) =>
      `These two tracks are too different in speed to blend. Slide the CROSSFADER quickly all the way to deck ${d}`,
    perfect: 'SMOOTH MIX',
    great: 'NICE MIX',
    quick: 'QUICK CUT',
    bassSwap: 'BASS SWAP',
    trainwreck: 'TRAINWRECK',
    cutPerfect: 'CLEAN CUT',
    cutGreat: 'GOOD CUT',
    cutSlow: 'SLOW CUT',
    already: 'ALREADY THERE',
    fail: 'TOO SLOW',
    rescue: (d: DeckId) => `FADING TO DECK ${d} FOR YOU`,
  },

  stopDeck: {
    title: (d: DeckId) => `STOP DECK ${d}`,
    hint: (d: DeckId) => `Nobody hears deck ${d} now. Press its PLAY button again to stop it`,
    done: 'CLEAN FINISH',
    ranOut: 'RAN OUT',
    fail: 'LEFT RUNNING',
    rescue: (d: DeckId) => `STOPPED DECK ${d} FOR YOU`,
  },

  bassDrop: {
    title: 'DROP THE BASS',
    cut: (d: DeckId) => `Turn the LOW knob on deck ${d} all the way down (to the left)`,
    wait: 'Bass is out! Get ready to turn LOW back up when the beat drops',
    /** k = 4, 3, 2, 1 beats to the drop */
    count: (d: DeckId, k: number) => `Turn LOW on deck ${d} back up when the beat drops in ${k}…`,
    now: (d: DeckId) => `NOW! Turn LOW on deck ${d} back up to the middle`,
    /** tutorial: no timing */
    back: (d: DeckId) => `Now turn LOW on deck ${d} back up to the middle`,
    perfect: 'ON THE DROP',
    great: 'CLOSE',
    early: 'TOO EARLY',
    late: 'TOO LATE',
    learned: 'BASS IS BACK',
    missed: 'MISSED THE DROP',
    stuck: 'NO BASS',
    rescue: 'BASS BACK ON FOR YOU',
  },

  filterSweep: {
    title: 'FILTER SWEEP',
    out: (d: DeckId) => `Turn the FILTER knob on deck ${d} slowly to the left until the music sounds dull`,
    back: (d: DeckId) => `Now turn FILTER on deck ${d} slowly back to the middle`,
    perfect: 'SMOOTH SWEEP',
    great: 'NICE SWEEP',
    quick: 'QUICK FLICK',
    missed: 'NO SWEEP',
    stuck: 'FILTER LEFT ON',
    rescue: 'FILTER RESET FOR YOU',
  },

  scratch: {
    title: 'SCRATCH!',
    hint: (d: DeckId, times: number) =>
      `Put a finger on the record on deck ${d} and rock it back and forth ${times} times`,
    perfect: 'WICKED SCRATCH',
    great: 'NICE SCRATCH',
    ok: 'SCRATCHED',
    letGo: (d: DeckId) => `Nice! Now let go of the record on deck ${d}`,
    fail: 'NO SCRATCH',
  },

  echoOut: {
    title: 'ECHO OUT',
    hold: (d: DeckId) => `Last bars! Hold the ECHO button on deck ${d}`,
    stop: (d: DeckId) => `Keep ECHO held and press PLAY on deck ${d} to stop the music`,
    perfect: 'PERFECT ENDING',
    great: 'NICE ENDING',
    noEcho: 'NO ECHO',
    fail: 'RAN OUT',
    rescue: 'ENDED THE SET FOR YOU',
  },

  recover: {
    title: 'BRING THE MUSIC BACK',
    play: (d: DeckId) => `The music stopped. Press the green PLAY button on deck ${d}`,
    fader: (d: DeckId) => `Deck ${d} is turned down. Slide its volume fader all the way up`,
    crossfader: (d: DeckId) => `The CROSSFADER is on the silent side. Slide it to the ${side(d)}, to deck ${d}`,
    letGo: (d: DeckId) => `Let go of the record on deck ${d} so it can play`,
    eq: (d: DeckId) => `Deck ${d} is muted. Turn its LOW knob back up to the middle`,
    done: 'MUSIC IS BACK',
    rescue: 'MUSIC BACK ON FOR YOU',
  },

  callout: {
    deadAir: 'DEAD AIR!',
    trainwreck: 'TRAINWRECK!',
    drop: 'DROP!',
    leaving: 'THE CROWD IS LEAVING!',
    smoothMix: 'SMOOTH MIX!',
    bassSwap: 'BASS SWAP!',
    inTheMix: 'IN THE MIX',
    combo: (multiplier: number) => `COMBO ×${multiplier}`,
    curfew: 'CLOSING TIME',
    skippedTrack: 'NEXT TRACK WOULD NOT LOAD',
  },

  status: {
    loading: 'GETTING THE DECKS READY',
    title: (title: string) => title.toUpperCase(),
    mixIn: (n: number) => `MIX IN ${bars(n)}`,
    mixing: (title: string) => `MIXING INTO ${title.toUpperCase()}`,
    fadeIn: (n: number) => `CROSSFADE IN ${bars(n)}`,
    fading: (d: DeckId) => `FADING TO DECK ${d}`,
    lastTrack: (title: string) => `LAST TRACK · ${title.toUpperCase()}`,
    lastBars: (n: number) => `LAST ${bars(n)}`,
    loadingNext: 'LOADING THE NEXT TRACK',
    deadAir: (advice: string) => `DEAD AIR · ${advice.toUpperCase()}`,
    trainwreck: 'TRAINWRECK · MATCH THE BEATS OR FADE ONE DECK OUT',
    leaving: 'WIN THE CROWD BACK!',
    complete: 'SET COMPLETE',
    crowdLeft: 'THE CROWD LEFT',
    pads: (hits: number, need: number) => `TAP A PAD WHEN A NOTE REACHES THE LINE · ${hits}/${need}`,
    lessonDone: 'LESSON COMPLETE',
    freeIdle: 'FREE PLAY · PRESS PLAY ON A DECK',
    freeEmpty: 'FREE PLAY · LOAD A TRACK',
    inTheMix: 'IN THE MIX',
  },

  /** short advice used in the dead-air status line */
  advice: {
    play: (d: DeckId) => `press PLAY on deck ${d}`,
    fader: (d: DeckId) => `slide deck ${d}'s volume fader up`,
    crossfader: (d: DeckId) => `slide the CROSSFADER to deck ${d}`,
    letGo: (d: DeckId) => `let go of the record on deck ${d}`,
    eq: (d: DeckId) => `turn deck ${d}'s LOW, MID and HI back up`,
  },
} as const;
