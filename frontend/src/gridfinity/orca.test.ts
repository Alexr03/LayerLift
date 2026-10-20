// Optional: round-trip a bin's 3MF through the OrcaSlicer CLI, like backend/tests/test_orca.py.
// Skipped unless OrcaSlicer is installed (ORCA_SLICER, or the default Windows/macOS/Linux paths).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, it } from 'vitest'
import { export3mf } from './export'
import { Builder } from './geometry'
import { loadManifold } from './mf'
import { binParts } from './parts'
import { loadFont } from './text'
import { DEFAULT_BIN, DEFAULT_FILAMENTS, normaliseBin } from './types'

const ORCA = [
  process.env.ORCA_SLICER ?? '',
  'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
  '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
  '/usr/bin/orca-slicer',
].find((p) => p && existsSync(p))

it.skipIf(!ORCA)('OrcaSlicer keeps the parts and their slots', async () => {
  const M = await loadManifold()
  const woff = readFileSync(fileURLToPath(new URL('../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff', import.meta.url)))
  const g = new Builder(M, loadFont(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength) as ArrayBuffer))
  const design = normaliseBin({ ...DEFAULT_BIN, w: 2, h: 4, divX: 1, tab: 'full', labels: ['M3', 'M4'], holes: 'magnets', body: 0, labelFilament: 3 })
  const { parts } = binParts(g, design, DEFAULT_FILAMENTS)
  const dir = mkdtempSync(join(tmpdir(), 'layerlift-orca-'))
  writeFileSync(join(dir, 'bin.3mf'), export3mf('Test bin', parts.map((p) => ({ name: p.name, slot: p.filament + 1, mesh: p.mesh }))))
  execFileSync(ORCA!, ['--outputdir', dir, '--export-3mf', 'roundtrip.3mf', join(dir, 'bin.3mf')], { cwd: dir, timeout: 300_000, stdio: 'pipe' })
  const files = unzipSync(readFileSync(join(dir, 'roundtrip.3mf')))
  const settings = strFromU8(files['Metadata/model_settings.config'])
  expect(settings.match(/<object /g)?.length).toBe(1)
  const names = [...settings.matchAll(/<part id="\d+"[^>]*>\s*<metadata key="name" value="([^"]+)"/g)].map((m) => m[1])
  expect(names).toEqual(['01 Grey', '04 Blue'])
  const slots = [...settings.matchAll(/<part id="\d+"[^>]*>(?:(?!<\/part>)[\s\S])*?(?:key="extruder" value="(\d+)"|<\/part>)/g)].map((m) => m[1] ?? '1')
  expect(slots).toEqual(['1', '4'])
}, 300_000)
