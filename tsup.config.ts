import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  // @xterm/headless + @xterm/addon-serialize ship CommonJS only; ESM
  // named-import (`import { Terminal } from '@xterm/headless'`) fails at
  // runtime under Node ESM. Bundling them into our ESM output sidesteps
  // the interop trap.
  noExternal: ['@xterm/headless', '@xterm/addon-serialize'],
});
