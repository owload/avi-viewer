import { defineConfig } from 'vitest/config';

// Library build (`npm run build`) and unit tests (`npm test`).
export default defineConfig({
  build: {
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: { 'avi-viewer': 'src/index.ts', extension: 'src/extension.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'style',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime'],
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
