/**
 * verylot-verify — verify Verylot digits without trusting the Verylot website.
 *
 *   verylot-verify --file verylot-proof.json          (the proof downloaded from the site's Verify window)
 *   verylot-verify --api https://api.verylot.online --key vk_7Qm2xR9a --pem verylot.pem --at 2026-10-05T12:00:00Z --digits 6
 *
 * verylot.online's API is for members: --key and --pem sign the requests (Ed25519 private key). A self-hosted
 * reference generator needs neither.
 *
 * Exit code 0 = every digit verified, 1 = at least one failed, 2 = usage / input error.
 */
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fetchProofBundle, type RequestHeaders } from './api.js'
import { slotAtOrAfter } from './protocol.js'
import { verifyBundle, type ProofBundle, type SlotVerification } from './verify.js'

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'https://api.verylot.online' },
    at: { type: 'string' },
    digits: { type: 'string', default: '6' },
    file: { type: 'string' },
    key: { type: 'string' },
    pem: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

/** The member API's signature headers: Ed25519 over METHOD \n path?query \n timestamp \n nonce \n hex sha256(body). */
async function signer(keyId: string, pemFile: string): Promise<RequestHeaders> {
  const key = createPrivateKey(await readFile(pemFile, 'utf8'))
  return path => {
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const nonce = randomBytes(16).toString('base64url')
    const text = ['GET', path, ts, nonce, createHash('sha256').update('').digest('hex')].join('\n')
    return {
      'X-Verylot-Key': keyId, 'X-Verylot-Timestamp': ts, 'X-Verylot-Nonce': nonce,
      'X-Verylot-Signature': sign(null, Buffer.from(text), key).toString('base64'),
    }
  }
}

const ok = (b: boolean) => (b ? '✓' : '✗')

function print(results: SlotVerification[]) {
  for (const r of results) {
    console.log(`\n${ok(r.ok)} ${r.time}  slot ${r.slot}  digit ${r.claimedDigit}`)
    console.log(`  ${ok(r.commitment.ok)} commitment  ${r.commitment.day} ${r.commitment.commitment.slice(0, 16)}…  committed ${r.commitment.committedAt ?? '?'} (${r.commitment.leadSeconds ?? '?'}s before the slot)`)
    console.log(`  ${ok(r.seedChain.ok)} seed        ${r.seedChain.seed.slice(0, 16)}…  ${r.seedChain.ok ? 'reaches' : 'does NOT reach'} the commitment in ${r.seedChain.steps} steps`)
    console.log(`  ${ok(r.drand.ok)} drand       round #${r.drand.expectedRound} (claimed #${r.drand.claimedRound}) · ${r.drand.status} from ${r.drand.source ?? '-'}${r.drand.matchesClaimed ? '' : " · differs from Verylot's copy"}${r.drand.error ? ` · ${r.drand.error}` : ''}`)
    if (r.derivation)
      console.log(`  ${ok(r.derivation.ok)} digit       HMAC ${r.derivation.mac.slice(0, 16)}… byte[${r.derivation.byteIndex}] = ${r.derivation.byteValue} → ${r.derivation.byteValue} mod 10 = ${r.derivation.digit}`)
  }
  const passed = results.filter(r => r.ok).length
  console.log(`\n${passed === results.length ? '✓' : '✗'} ${passed}/${results.length} digits verified: ${results.map(r => r.claimedDigit).join('')}`)
}

async function main(): Promise<number> {
  let bundle: ProofBundle
  if (values.file) {
    bundle = JSON.parse(await readFile(values.file, 'utf8')) as ProofBundle
  } else if (values.at) {
    const at = new Date(values.at.endsWith('Z') || /[+-]\d\d:\d\d$/.test(values.at) ? values.at : `${values.at}Z`)
    if (Number.isNaN(at.getTime())) throw new Error(`--at is not a valid time: ${values.at}`)
    if (!values.key !== !values.pem) throw new Error('--key and --pem go together (the key id and its private key file)')
    // Verylot's API answers members only (signed); a self-hosted reference generator needs no key.
    const headers = values.key && values.pem ? await signer(values.key, values.pem) : undefined
    bundle = await fetchProofBundle(values.api!, slotAtOrAfter(at), Number(values.digits), headers)
  } else {
    console.error('usage: verylot-verify (--file <proof.json> | --at <UTC time> [--digits 6] [--api <url>] [--key <key id> --pem <private key>]) [--json]')
    return 2
  }

  if (bundle.proofs.length === 0) {
    console.error('No produced digits in that range yet.')
    return 2
  }

  const results = await verifyBundle(bundle)
  if (values.json) console.log(JSON.stringify(results, null, 2))
  else print(results)
  return results.every(r => r.ok) ? 0 : 1
}

main().then(
  code => process.exit(code),
  e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(2)
  },
)
