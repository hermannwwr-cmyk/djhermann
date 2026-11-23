// placeholder
import { h } from './dom';
export interface LoadingOverlay { el: HTMLElement; show(label?: string): void; set(progress: number, label?: string): void; hide(): Promise<void> }
export function createLoadingOverlay(): LoadingOverlay {
  const el = h('div', 'sc-loading');
  return { el, show() {}, set() {}, async hide() {} };
}
