/**
 * Verifies Verylot digits from their proof material. Nothing returned by the Verylot API is trusted
 * on its own: the seed must hash to the day's commitment, the commitment must predate the slot, the
 * drand beacon is fetched from drand itself and its BLS signature checked, and the digit is recomputed.
 */
import { fetchVerifiedBeacon, type BeaconResult } from './drand.js'
import {
  dayOf,
  deriveDigit,
  drandRoundForSlot,
  hexToBytes,
  seedReachesCommitment,
  sha256Hex,
  slotTime,
  type Derivation,
} from './protocol.js'

/** One slot as returned by GET /v1/stream/proof. Hex strings. */
export interface SlotProof {
  slot: number
  time: string
  digit: number
  seed: string
  drandRound: number
  drandRandomness: string
  drandSignature: string
  day: string
  commitment: string
}

/** One day as returned by GET /v1/commitments. */
export interface DayCommitment {
  day: string
  commitment: string
  committedAt: string
}

/** Everything needed to verify offline-from-Verylot: the downloadable proof file. */
export interface ProofBundle {
  protocol: 'verylot/v1'
  proofs: SlotProof[]
  commitments: DayCommitment[]
}

export interface SlotVerification {
  slot: number
  time: string
  claimedDigit: number
  ok: boolean
  commitment: {
    ok: boolean
    day: string
    commitment: string
    committedAt: string | null
    /** Seconds between publishing the commitment and the slot; must be > 0. */
    leadSeconds: number | null
  }
  seedChain: {
    ok: boolean
    seed: string
    /** Hashes from the revealed seed to the commitment. */
    steps: number
  }
  drand: {
    ok: boolean
    expectedRound: number
    claimedRound: number
    status: BeaconResult['status']
    source: string | null
    randomness: string | null
    /** drand's randomness equals the one Verylot stored. */
    matchesClaimed: boolean
    error: string | null
  }
  derivation: (Derivation & { ok: boolean }) | null
}

export interface VerifyOptions {
  drandRelays?: string[]
}

export async function verifyBundle(bundle: Pick<ProofBundle, 'proofs' | 'commitments'>, options: VerifyOptions = {}): Promise<SlotVerification[]> {
  const commitments = new Map(bundle.commitments.map(c => [c.day, c]))
  return Promise.all(bundle.proofs.map(p => verifySlot(p, commitments.get(dayOf(p.slot)), options)))
}

async function verifySlot(proof: SlotProof, published: DayCommitment | undefined, options: VerifyOptions): Promise<SlotVerification> {
  const slotAt = slotTime(proof.slot)

  // 1. Commitment: the published one for the slot's UTC day, made before the slot started.
  const day = dayOf(proof.slot)
  const commitmentHex = published?.commitment ?? proof.commitment
  const leadSeconds = published ? (slotAt.getTime() - new Date(published.committedAt).getTime()) / 1000 : null
  const commitment = {
    ok: !!published && published.commitment === proof.commitment && proof.day === day && leadSeconds! > 0,
    day,
    commitment: commitmentHex,
    committedAt: published?.committedAt ?? null,
    leadSeconds,
  }

  // 2. Seed: hashes forward to that commitment.
  const seedBytes = hexToBytes(proof.seed)
  const chain = seedReachesCommitment(seedBytes, proof.slot, hexToBytes(commitmentHex))
  const seedChain = { ok: chain.ok, seed: proof.seed, steps: chain.steps }

  // 3. drand: the round fixed by formula, fetched from drand and BLS-verified.
  const expectedRound = drandRoundForSlot(proof.slot)
  const beacon = await fetchVerifiedBeacon(expectedRound, options.drandRelays)
  const valid = beacon.status === 'valid' ? beacon.beacon : null
  const randomnessOk = !!valid && sha256Hex(hexToBytes(valid.signature)) === valid.randomness
  const drand = {
    ok: !!valid && randomnessOk && proof.drandRound === expectedRound,
    expectedRound,
    claimedRound: proof.drandRound,
    status: beacon.status,
    source: valid?.source ?? (beacon.status === 'invalid' ? beacon.source : null),
    randomness: valid?.randomness ?? null,
    matchesClaimed: !!valid && valid.randomness === proof.drandRandomness,
    error: beacon.status === 'valid' ? null : beacon.error,
  }

  // 4. Recompute the digit from the verified seed and drand's own randomness.
  const derivation = valid
    ? (() => {
        const d = deriveDigit(seedBytes, proof.slot, hexToBytes(valid.randomness))
        return { ...d, ok: d.digit === proof.digit }
      })()
    : null

  return {
    slot: proof.slot,
    time: proof.time,
    claimedDigit: proof.digit,
    ok: commitment.ok && seedChain.ok && drand.ok && !!derivation?.ok,
    commitment,
    seedChain,
    drand,
    derivation,
  }
}
