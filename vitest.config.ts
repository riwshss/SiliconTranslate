import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**', 'src/content/text-state.ts', 'src/content/dom-classify.ts'],
      exclude: ['src/shared/messages.ts'],
    },
  },
})
