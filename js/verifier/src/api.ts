/** Loads proof material from a Verylot API (the data to be verified — not trusted by itself). */
import { dayOf } from './protocol.js'
import { verifyBundle, type DayCommitment, type ProofBundle, type SlotProof, type SlotVerification, type VerifyOptions } from './verify.js'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
  return (await res.json()) as T
}

/** Proofs for `count` slots from `fromSlot`, plus the commitments of the days they fall in. */
export async function fetchProofBundle(apiBase: string, fromSlot: number, count: number): Promise<ProofBundle> {
  const base = apiBase.replace(/\/$/, '')
  const proofs = await getJson<SlotProof[]>(`${base}/v1/stream/proof?from=${fromSlot}&count=${count}`)
  const firstDay = dayOf(fromSlot)
  const lastDay = dayOf(fromSlot + count - 1)
  const commitments = await getJson<DayCommitment[]>(`${base}/v1/commitments?from=${firstDay}&to=${lastDay}`)
  return { protocol: 'verylot/v1', proofs, commitments }
}

export async function verifyRange(apiBase: string, fromSlot: number, count: number, options?: VerifyOptions): Promise<{ bundle: ProofBundle; results: SlotVerification[] }> {
  const bundle = await fetchProofBundle(apiBase, fromSlot, count)
  return { bundle, results: await verifyBundle(bundle, options) }
}
