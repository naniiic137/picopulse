import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /picopulse/; the dev server uses /.
// `vite preview` serves the production build, so it needs the same base.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/picopulse/' : '/',
  server: { port: 5183, strictPort: true },
  preview: { port: 5183, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
}));
