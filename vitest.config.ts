import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests run by default (`npm test`) and by the pre-commit quality gate, so they
// must stay fast and hermetic — dockerode is mocked, no real containers.
// Integration tests (`*.integration.test.ts`) drive real Docker and are opt-in via
// `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
