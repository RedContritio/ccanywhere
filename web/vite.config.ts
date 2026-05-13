/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_URL = process.env['CCANYWHERE_DEV_SERVER'] ?? 'http://127.0.0.1:62275';

function readGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const CC_VERSION = `${readGitSha()} @ ${new Date().toISOString()}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __CC_VERSION__: JSON.stringify(CC_VERSION),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER_URL, changeOrigin: true },
      '/ws': { target: SERVER_URL.replace('http', 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
