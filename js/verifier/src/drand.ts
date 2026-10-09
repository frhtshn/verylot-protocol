/**
 * Fetches a quicknet beacon straight from public drand relays (never from Verylot) and verifies its
 * BLS signature against the pinned chain hash and public key, using drand's official client.
 */
import { fetchBeacon, HttpCachingChain, HttpChainClient, type ChainOptions } from 'drand-client'
import { DRAND_QUICKNET } from './protocol.js'

export const DEFAULT_DRAND_RELAYS = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
]

export interface VerifiedBeacon {
  round: number
  randomness: string
  signature: string
  /** Relay the beacon came from. */
  source: string
}

export type BeaconResult =
  | { status: 'valid'; beacon: VerifiedBeacon }
  | { status: 'invalid'; source: string; error: string } // a relay served a beacon that fails BLS verification
  | { status: 'unreachable'; error: string } // no relay answered

const options: ChainOptions = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: { chainHash: DRAND_QUICKNET.chainHash, publicKey: DRAND_QUICKNET.publicKey },
}

const clients = new Map<string, HttpChainClient>()

function clientFor(relay: string): HttpChainClient {
  let client = clients.get(relay)
  if (!client) {
    client = new HttpChainClient(new HttpCachingChain(`${relay}/${DRAND_QUICKNET.chainHash}`, options), options)
    clients.set(relay, client)
  }
  return client
}

/** Tries relays in order; a verification failure is final (it is not a network problem). */
export async function fetchVerifiedBeacon(round: number, relays = DEFAULT_DRAND_RELAYS): Promise<BeaconResult> {
  const errors: string[] = []
  for (const relay of relays) {
    try {
      const beacon = await fetchBeacon(clientFor(relay), round)
      return { status: 'valid', beacon: { round: beacon.round, randomness: beacon.randomness, signature: beacon.signature, source: relay } }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/verif/i.test(message)) return { status: 'invalid', source: relay, error: message }
      errors.push(`${relay}: ${message}`)
    }
  }
  return { status: 'unreachable', error: errors.join('; ') }
}
