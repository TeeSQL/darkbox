import { defineConfig } from 'vite';

// Standalone static app. No shared deps — builds to plain HTML/JS/CSS that can be
// dropped onto any static host (replay.repo.box).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
