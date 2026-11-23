// placeholder: replaced by the real screen
import type { AppContext, Screen } from '../../core/types';
import { h } from './dom';

export function createSetupScreen(_ctx: AppContext): Screen<never> {
  const el = h('div', 'sc-screen', h('div', 'sc-top', h('div', 'sc-top__title', 'setup')));
  return { el };
}
