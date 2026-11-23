import './styles/base.css';
import { loadFonts } from './core/fonts';

// Placeholder bootstrap. The real app shell is wired up in src/app once the modules exist.
void loadFonts().then(() => {
  const app = document.getElementById('app')!;
  app.innerHTML =
    '<div class="app-frame" style="display:grid;place-items:center"><h1 class="ui-display ui-aurora-text" style="font-size:40px">DJ HERMANN</h1></div>';
});
