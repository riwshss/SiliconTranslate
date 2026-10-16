import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**', 'src/content/text-state.ts', 'src/content/dom-classify.ts', 'server/src/app.ts', 'server/src/quota.ts'],
      exclude: ['src/shared/messages.ts'],
    },
  },
})
