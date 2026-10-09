# @verylot/verifier

Independent verifier for Verylot digits (protocol v1). Use it to check a result **without trusting the Verylot website**.

For every digit it checks:

1. **Commitment** — the day's seed-chain commitment was published *before* the slot started.
2. **Seed** — the revealed seed hashes forward to that commitment (`SHA256("verylot/chain/v1" ‖ seed)`, index + 1 times).
3. **drand** — the beacon for the round fixed by formula is fetched **from drand's own relays** and its BLS signature is checked against the pinned quicknet public key.
4. **Digit** — recomputed: first byte `b < 250` of `HMAC-SHA256(seed, "verylot/digit/v1" ‖ slot ‖ counter ‖ drand_randomness)`, `b % 10`.

## CLI

```bash
node dist/cli.js --api https://api.verylot.online --at 2026-10-05T12:00:00Z --digits 6
node dist/cli.js --file verylot-proof.json          # proof file downloaded from the site
```

Exit code `0` = all digits verified, `1` = at least one failed, `2` = input error.

## Library

```ts
import { verifyRange, verifyBundle } from '@verylot/verifier'

const { results } = await verifyRange('https://api.verylot.online', startSlot, 6)
results.every(r => r.ok)
```

## Build

```bash
npm install
npm run build      # dist/index.js (browser ESM), dist/cli.js (Node)
npm test           # against ../../test-vectors/v1.json
```

`src/protocol.ts` must give the same results as `dotnet/Verylot.Core`; both are tested against `test-vectors/v1.json`.
