import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The upstream reference checkout under .upstream/ carries its own test
    // suite, which exercises the desktop-credential decryption we deliberately
    // do not use. Running it here would report its Windows-environment
    // failures as ours, so the glob is scoped to our own tests/ only.
    include: ['tests/**/*.spec.ts'],
    // Every test runs with a throwaway `$DSH_HOME`. Without it a test that
    // builds a state store without naming a path writes into the developer's
    // real home — see the note in `tests/setup-dsh-home.ts`.
    setupFiles: ['tests/setup-dsh-home.ts'],
  },
})
