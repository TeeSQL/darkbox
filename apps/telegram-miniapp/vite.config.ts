import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        web: resolve(__dirname, 'web.html'),
        daemons: resolve(__dirname, 'daemons.html'),
        dynamicFlow: resolve(__dirname, 'dynamic-flow.html'),
      },
    },
  },
});
