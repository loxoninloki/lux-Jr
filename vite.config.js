
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/lux-Jr/',
  publicDir: false,
  build: {
    target: 'es2022',
    assetsInlineLimit: (path) =>
      path.endsWith('live-processor.js') ? false : undefined
  }
});
