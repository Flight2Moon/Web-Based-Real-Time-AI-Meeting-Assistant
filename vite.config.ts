import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer → multi-threaded WASM inference.
// In production (GitHub Pages can't set headers) public/coi-sw.js adds the same headers.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: './',
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
});
