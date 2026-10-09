/**
 * verylot-verify — verify Verylot digits without trusting the Verylot website.
 *
 *   verylot-verify --api https://api.verylot.online --at 2026-10-05T12:00:00Z --digits 6
 *   verylot-verify --file verylot-proof.json
 *
 * Exit code 0 = every digit verified, 1 = at least one failed, 2 = usage / input error.
 */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fetchProofBundle } from './api.js'
import { slotAtOrAfter } from './protocol.js'
import { verifyBundle, type ProofBundle, type SlotVerification } from './verify.js'

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'https://api.verylot.online' },
    at: { type: 'string' },
    digits: { type: 'string', default: '6' },
    file: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

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
    bundle = await fetchProofBundle(values.api!, slotAtOrAfter(at), Number(values.digits))
  } else {
    console.error('usage: verylot-verify (--at <UTC time> [--digits 6] [--api <url>] | --file <proof.json>) [--json]')
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
