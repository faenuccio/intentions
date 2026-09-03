import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maintainerCc } from '../src/commands/deps.js'
import type { Config } from '../src/config.js'

const cfg = (notifyMaintainers: string[]): Config =>
  ({ notifyMaintainers } as unknown as Config)

test('no cc line when nobody is configured and nobody else is named', () => {
  assert.equal(maintainerCc(cfg([])), '')
})

test('the configured maintainers are mentioned', () => {
  assert.equal(maintainerCc(cfg(['faenuccio', 'kim-em'])), '\n\ncc @faenuccio @kim-em')
})

test('an extra mention comes first, and the list still applies', () => {
  assert.equal(maintainerCc(cfg(['kim-em']), ['lua-vr']), '\n\ncc @lua-vr @kim-em')
})

test('a name appearing twice is mentioned once, case-insensitively', () => {
  assert.equal(maintainerCc(cfg(['Kim-Em']), ['kim-em']), '\n\ncc @kim-em')
})

test('a leading @ in configuration is tolerated, and blanks are dropped', () => {
  assert.equal(maintainerCc(cfg(['@kim-em', '']), ['']), '\n\ncc @kim-em')
})

test('an extra mention alone produces a cc line even with nobody configured', () => {
  assert.equal(maintainerCc(cfg([]), ['lua-vr']), '\n\ncc @lua-vr')
})
