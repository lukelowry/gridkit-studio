import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    // What the unit tests reach, as `pnpm coverage` reports it; nothing gates on it.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'output/coverage',
    },
    projects: [
      // Unit tests beside the code they test, the VS Code suites' own included; they run anywhere.
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/*.test.ts'],
          clearMocks: true,
        },
      },
      // GridKit's own DynamicSimulation, run where GridKit is installed or as GRIDKIT_IMAGE.
      {
        test: {
          name: 'simulation',
          environment: 'node',
          include: ['tests/simulation/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
