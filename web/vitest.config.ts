import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom rather than node: importing INSERT_ITEMS pulls in the sketch module,
    // which imports react-dom/client and a TipTap ReactNodeViewRenderer. Neither
    // touches the DOM at module scope today, but a plain node environment makes that
    // an accident away from a red suite, and this is a browser app.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
