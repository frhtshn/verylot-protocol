// The verifier's protocol code against test-vectors/v1.json (the C# reference runs the same file).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chainStep, dayOf, deriveDigit, drandRoundForSlot, hexToBytes, bytesToHex, indexInDay, seedReachesCommitment, slotTime } from '../src/protocol.ts'

const v = JSON.parse(readFileSync(new URL('../../../test-vectors/v1.json', import.meta.url), 'utf8'))

test('slots', () => {
  for (const s of v.slots) {
    assert.equal(slotTime(s.slot).toISOString().replace('.000', ''), s.time, s.note)
    assert.equal(dayOf(s.slot), s.day, s.note)
    assert.equal(indexInDay(s.slot), s.indexInDay, s.note)
    assert.equal(drandRoundForSlot(s.slot), s.drandRound, s.note)
  }
})

test('chain from root', () => {
  // s[k-1] = step(s[k]); the seed for day index i is s[i+1], the root is s[8640].
  let x = hexToBytes(v.chain.root)
  const seeds = new Map<number, string>([[8639, bytesToHex(x)]])
  for (let i = 8638; i >= -1; i--) {
    x = chainStep(x)
    seeds.set(i, bytesToHex(x))
  }
  assert.equal(seeds.get(-1), v.chain.commitment)
  for (const s of v.chain.seeds) assert.equal(seeds.get(s.indexInDay), s.seed)
})

test('chain checks', () => {
  for (const c of v.chainChecks) {
    // seedReachesCommitment takes a slot; any slot with the same day index will do.
    const { ok } = seedReachesCommitment(hexToBytes(c.seed), c.indexInDay, hexToBytes(c.commitment))
    assert.equal(ok, c.valid, c.note)
  }
})

test('digits', () => {
  for (const d of v.digits) {
    const r = deriveDigit(hexToBytes(d.seed), d.slot, hexToBytes(d.drandRandomness))
    assert.deepEqual([r.digit, r.mac, r.byteIndex, r.byteValue], [d.digit, d.mac, d.byteIndex, d.byteValue], d.note)
  }
})
