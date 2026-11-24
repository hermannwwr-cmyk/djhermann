/**
 * Menus and PWA-facing screens: everything outside the game itself.
 *
 *   registerScreens(ctx)      title, home, setup, library, settings, calibrate, howto, results
 *   createLoadingOverlay()    "pressing the record" overlay shown while tracks are prepared
 *   openTrackPicker(...)      bottom sheet over the game to choose a track (free play)
 *   createAmbientBackground() the animated backdrop behind the menus
 */
import './screens.css';
import type { NavController } from '../../core/nav';
import type { AppContext } from '../../core/types';
import { createCalibrateScreen } from './calibrate';
import { createHomeScreen } from './home';
import { createHowToScreen } from './howto';
import { createLibraryScreen } from './library';
import { createResultsScreen } from './results';
import { createSettingsScreen } from './settings';
import { createSetupScreen } from './setup';
import { shared } from './shared';
import { createTitleScreen } from './title';

export { createAmbientBackground } from './ambient';
export type { AmbientBackground } from './ambient';
export { createLoadingOverlay } from './loading';
export type { LoadingOverlay } from './loading';
export { openTrackPicker } from './picker';
export type { TrackPickerOptions } from './picker';

/** Registers every menu screen with the navigator. The game screen ('game') belongs to the app shell. */
export function registerScreens(ctx: AppContext & { nav: NavController }): void {
  shared.settings = ctx.settings;
  const { nav } = ctx;
  nav.register('title', () => createTitleScreen(ctx));
  nav.register('home', () => createHomeScreen(ctx));
  nav.register('setup', () => createSetupScreen(ctx));
  nav.register('library', () => createLibraryScreen(ctx));
  nav.register('settings', () => createSettingsScreen(ctx));
  nav.register('calibrate', () => createCalibrateScreen(ctx));
  nav.register('howto', () => createHowToScreen(ctx));
  nav.register('results', () => createResultsScreen(ctx));
}
