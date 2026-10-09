import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
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
