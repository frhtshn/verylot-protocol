/**
 * Verylot protocol v1 — the pure, deterministic part. Must stay byte-for-byte identical to
 * src/Verylot.Core (SlotClock, SeedChain, DrandChain, DigitDerivation).
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

export const SLOT_SECONDS = 10
export const SLOTS_PER_DAY = 86_400 / SLOT_SECONDS // 8640

/** League of Entropy "quicknet". Pinned here so a server can't substitute another chain or key. */
export const DRAND_QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesisTime: 1692803367,
  period: 3,
} as const

const CHAIN_TAG = utf8ToBytes('verylot/chain/v1')
const DIGIT_TAG = utf8ToBytes('verylot/digit/v1')
const ACCEPT_BELOW = 250 // 25 × 10: every digit gets exactly 25/250 = 10%

// ---- slots -------------------------------------------------------------------------------------

/** Slot that starts at or after the given time (12:00:05 → 12:00:10). */
export const slotAtOrAfter = (date: Date): number => Math.ceil(date.getTime() / (SLOT_SECONDS * 1000))

export const slotTime = (slot: number): Date => new Date(slot * SLOT_SECONDS * 1000)

/** UTC day of a slot as YYYY-MM-DD. Days start on slot multiples of 8640. */
export const dayOf = (slot: number): string => slotTime(slot).toISOString().slice(0, 10)

/** 0-based position of the slot inside its UTC day (0 … 8639). */
export const indexInDay = (slot: number): number => slot % SLOTS_PER_DAY

// ---- seed chain --------------------------------------------------------------------------------

/** s[k-1] = SHA256("verylot/chain/v1" ‖ s[k]) */
export const chainStep = (seed: Uint8Array): Uint8Array => sha256(concatBytes(CHAIN_TAG, seed))

/**
 * The seed revealed for day index i is s[i+1]; hashing it i+1 times must give the day's commitment s[0].
 * Returns the number of steps taken (i+1) and whether the commitment was reached.
 */
export function seedReachesCommitment(seed: Uint8Array, slot: number, commitment: Uint8Array) {
  const steps = indexInDay(slot) + 1
  let x = seed
  for (let k = 0; k < steps; k++) x = chainStep(x)
  return { steps, ok: bytesToHex(x) === bytesToHex(commitment) }
}

// ---- drand -------------------------------------------------------------------------------------

/** First quicknet round published at or after the slot time. Fixed by formula — never chosen. */
export function drandRoundForSlot(slot: number): number {
  const t = slot * SLOT_SECONDS
  const { genesisTime, period } = DRAND_QUICKNET
  return t <= genesisTime ? 1 : Math.ceil((t - genesisTime) / period) + 1
}

export const drandRoundTime = (round: number): Date =>
  new Date((DRAND_QUICKNET.genesisTime + (round - 1) * DRAND_QUICKNET.period) * 1000)

// ---- digit -------------------------------------------------------------------------------------

export interface Derivation {
  digit: number
  /** Counter used (0 unless all 32 bytes were ≥ 250, ≈ 10⁻⁵² chance). */
  counter: number
  /** The HMAC that produced the digit, hex. */
  mac: string
  /** Position and value of the first byte < 250. */
  byteIndex: number
  byteValue: number
}

/**
 * digit = first byte b < 250 of HMAC-SHA256(key: seed,
 *           msg: "verylot/digit/v1" ‖ slot (int64 BE) ‖ counter (uint32 BE) ‖ drand_randomness) → b % 10
 */
export function deriveDigit(seed: Uint8Array, slot: number, drandRandomness: Uint8Array): Derivation {
  const message = new Uint8Array(DIGIT_TAG.length + 8 + 4 + drandRandomness.length)
  const view = new DataView(message.buffer)
  message.set(DIGIT_TAG, 0)
  view.setBigInt64(DIGIT_TAG.length, BigInt(slot), false)
  message.set(drandRandomness, DIGIT_TAG.length + 12)

  for (let counter = 0; ; counter++) {
    view.setUint32(DIGIT_TAG.length + 8, counter, false)
    const mac = hmac(sha256, seed, message)
    const byteIndex = mac.findIndex(b => b < ACCEPT_BELOW)
    if (byteIndex >= 0) {
      const byteValue = mac[byteIndex]!
      return { digit: byteValue % 10, counter, mac: bytesToHex(mac), byteIndex, byteValue }
    }
  }
}

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))
