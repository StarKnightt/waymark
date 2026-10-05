import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  optimizeDeps: { exclude: ['@litert-lm/core'] },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), build: resolve(__dirname, 'build.html'), eval: resolve(__dirname, 'eval.html') },
    },
  },
});
