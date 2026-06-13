import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        web: resolve(__dirname, 'web.html'),
        daemons: resolve(__dirname, 'daemons.html'),
      },
    },
  },
});
