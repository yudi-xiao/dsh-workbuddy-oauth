/**
 * Point the whole suite at a throwaway `$DSH_HOME`.
 *
 * The plugin resolves several state files from `$DSH_HOME` (accounts, probe
 * records, preferences). A test that constructs one of those stores without an
 * explicit path therefore writes into the *real* home directory — which it did:
 * `probe-service.spec.ts` created `$DSH_HOME/.workbuddy-probe.json` on the
 * developer's machine on every run, and a "clean up leftovers" pass found the
 * file back minutes after deleting it.
 *
 * Per-test overrides still work (and are still the right tool when a test needs
 * to inspect the files it wrote); this only supplies a safe default so a test
 * that forgets one cannot escape. Registered as `setupFiles` in
 * `vitest.config.ts`, so it runs before every test file.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsh-workbuddy-test-home-'))
process.env['DSH_HOME'] = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})
