/** Loads proof material from a Verylot API (the data to be verified — not trusted by itself). */
import { dayOf } from './protocol.js'
import { verifyBundle, type DayCommitment, type ProofBundle, type SlotProof, type SlotVerification, type VerifyOptions } from './verify.js'

/**
 * Headers for one API request, given its path with query (e.g. /v1/stream/proof?from=1&count=6). The API answers
 * signed member requests only (X-Verylot-Key, -Timestamp, -Nonce, -Signature; see the CLI's --key / --pem).
 */
export type RequestHeaders = (pathAndQuery: string) => Record<string, string> | Promise<Record<string, string>>

async function getJson<T>(base: string, path: string, headers?: RequestHeaders): Promise<T> {
  const res = await fetch(base + path, { headers: headers ? await headers(path) : {} })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${base}${path}`)
  return (await res.json()) as T
}

/** Proofs for `count` slots from `fromSlot`, plus the commitments of the days they fall in. */
export async function fetchProofBundle(apiBase: string, fromSlot: number, count: number, headers?: RequestHeaders): Promise<ProofBundle> {
  const base = apiBase.replace(/\/$/, '')
  const proofs = await getJson<SlotProof[]>(base, `/v1/stream/proof?from=${fromSlot}&count=${count}`, headers)
  const firstDay = dayOf(fromSlot)
  const lastDay = dayOf(fromSlot + count - 1)
  const commitments = await getJson<DayCommitment[]>(base, `/v1/commitments?from=${firstDay}&to=${lastDay}`, headers)
  return { protocol: 'verylot/v1', proofs, commitments }
}

export async function verifyRange(apiBase: string, fromSlot: number, count: number, options?: VerifyOptions & { headers?: RequestHeaders }): Promise<{ bundle: ProofBundle; results: SlotVerification[] }> {
  const bundle = await fetchProofBundle(apiBase, fromSlot, count, options?.headers)
  return { bundle, results: await verifyBundle(bundle, options) }
}
