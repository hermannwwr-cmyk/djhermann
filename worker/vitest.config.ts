import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests of the room logic, in Node (no Workers runtime needed): `npm run test:worker`.
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-worker', import.meta.url)),
  test: { environment: 'node', include: ['**/*.test.ts'] },
});
