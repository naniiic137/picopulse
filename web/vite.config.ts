import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /picopulse/; the dev server uses /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/picopulse/' : '/',
  server: { port: 5183, strictPort: true },
  preview: { port: 5183, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
}));
