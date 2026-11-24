import { boot } from './app/boot';

void boot().catch((err) => {
  console.error('[main] boot failed', err);
  const app = document.getElementById('app');
  if (app) app.textContent = 'Something went wrong while starting. Please reload the page.';
});
