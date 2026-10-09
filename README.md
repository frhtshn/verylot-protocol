# Verylot protocol

Provably fair random digits. Every 10 seconds, one digit 0–9 is derived from two sources:

- a seed the operator committed to days in advance,
- a public [drand](https://drand.love) beacon that nobody can predict.

Anyone can recompute and verify every digit. See [SPEC.md](SPEC.md) for the full protocol.

This repository is the open engine behind [verylot.online](https://verylot.online). It contains everything needed to
**verify** Verylot's digits, and to **run your own** digit stream.

| Path | What it is |
|---|---|
| [`SPEC.md`](SPEC.md) | Protocol v1: slots, seed chain, drand round, digit derivation, HTTP interface |
| [`test-vectors/v1.json`](test-vectors/v1.json) | Fixed inputs and expected outputs. Both implementations are tested against them |
| [`dotnet/Verylot.Core`](dotnet/Verylot.Core) | Reference implementation (C#, NuGet `Verylot.Core`) |
| [`dotnet/Verylot.Reference`](dotnet/Verylot.Reference) | Self-hosted generator: commitments, one digit per slot, proof API. No database |
| [`js/verifier`](js/verifier) | Independent verifier for browsers and Node (npm `@verylot/verifier`, CLI `verylot-verify`) |

## Verify Verylot digits

```bash
cd js/verifier && npm ci && npm run build
node dist/cli.js --at 2026-10-05T12:00:00Z --digits 6
node dist/cli.js --file verylot-proof.json
```

For each digit, the verifier checks four things:

1. the commitment was published before the slot,
2. the seed hashes to the commitment,
3. drand's beacon, fetched from drand itself, has a valid BLS signature,
4. the recomputed digit matches.

## Run your own stream

```bash
cd dotnet
dotnet run --project Verylot.Reference -- --urls http://localhost:5080 --Data ./data
```

The generator does the following:

- keeps commitments 7 days ahead;
- produces one digit per slot, in order;
- after downtime, catches up from the last produced slot, so no slot is ever skipped;
- serves `/v1/commitments`, `/v1/stream/proof` and `/v1/stream/latest`.

Check it with the same verifier:

```bash
node js/verifier/dist/cli.js --api http://localhost:5080 --at <a recent UTC time> --digits 3
```

`data/<day>.json` holds that day's **secret root**. Anyone who reads it can predict that day's digits as soon as
drand publishes. Keep the directory private and back it up.

A digit stream is only as trustworthy as its commitment history. Publish your commitments early and keep them
public.

## Tests

```bash
cd dotnet && dotnet test
cd js/verifier && npm test
```

To regenerate the vectors, run `dotnet run tools/generate-vectors.cs > test-vectors/v1.json`. The output is
deterministic, so an unchanged protocol produces no diff.

## License

[Apache-2.0](LICENSE). The code is free to use, change and run commercially. The **Verylot** name and logo are not
covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
