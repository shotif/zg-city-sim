import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the same build works on GitHub Pages (/zg-city-sim/) and at a domain root.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~1.4 MB minified; it is cached separately from app code.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
