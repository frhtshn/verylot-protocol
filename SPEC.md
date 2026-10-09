# Verylot protocol v1

Verylot publishes one decimal digit (0–9) every 10 seconds. Two independent sources go into each digit:

- a **seed** that the operator locked days in advance with a hash-chain commitment,
- a **drand quicknet** beacon, which nobody can predict before it is published.

Neither side can choose or predict a digit alone. Anyone can recompute every digit from public data.

Notation: `‖` is byte concatenation. Strings are ASCII bytes. Integers are big-endian. Hex is lowercase.

## 1. Slots

```
slot           = floor(unix_seconds / 10)          (UTC)
slot_time      = slot × 10
day(slot)      = UTC date of slot_time
index_in_day   = slot mod 8640                     (0 … 8639)
```

A UTC day has exactly 8,640 slots, and every day starts on a multiple of 8640.

## 2. Seed chain (commit–reveal)

For each UTC day, the operator draws a secret 32-byte **root** and hashes backwards:

```
s[8640] = root                                     (32 random bytes, secret)
s[k-1]  = SHA-256("verylot/chain/v1" ‖ s[k])       for k = 8640 … 1
s[0]    = commitment
```

- The **commitment** `s[0]` is published **before the day starts**. The reference generator publishes it 7 days ahead.
- Slot `i` of the day uses the seed `s[i+1]`. Seeds are revealed in slot order, after each slot's digit is produced.
- **Check:** hash the revealed seed `i+1` times. The result must equal the commitment.

SHA-256 cannot be reversed, so a published commitment reveals no seed. It does fix all 8,640 seeds of that day.

## 3. drand round

The digit uses the drand **quicknet** chain:

| Parameter | Value |
|---|---|
| chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| public key | `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a` |
| genesis | `1692803367` |
| period | 3 seconds |
| scheme | unchained BLS on G1 (`bls-unchained-g1-rfc9380`) |

The round is the first one published at or after the slot's start. It is fixed by formula and cannot be chosen:

```
round = 1                                          if slot_time ≤ genesis
round = ceil((slot_time − genesis) / 3) + 1        otherwise
```

`randomness = SHA-256(signature)`. A verifier must fetch the beacon from drand itself and check its BLS signature
against the public key above. A verifier must never trust the operator's copy of the beacon.

## 4. Digit

```
message = "verylot/digit/v1" ‖ slot (int64) ‖ counter (uint32) ‖ randomness (32 bytes)
mac     = HMAC-SHA256(key = seed, message)
digit   = (first byte b of mac with b < 250) mod 10
```

The counter starts at 0. If all 32 bytes are 250 or more (about 1 in 10⁵²), the counter is incremented and the
HMAC is recomputed.

250 is the largest multiple of 10 that fits in a byte. Skipping bytes 250–255 gives every digit exactly 10%
probability.

## 5. Verifying a digit

A digit is valid only if all four checks pass:

1. **Commitment:** the day's commitment was published before the slot started.
2. **Seed:** the revealed seed hashes to the commitment in `index_in_day + 1` steps.
3. **drand:** the beacon for the formula's round, fetched from drand, has a valid BLS signature.
4. **Digit:** the digit recomputed from the seed and drand's randomness equals the published digit.

Check 1 relies on the operator's record of when it published the commitment. Third parties can strengthen it by
archiving commitments as soon as they appear.

## 6. HTTP interface

Operators expose the proof material as JSON. Both `api.verylot.online` and the reference generator implement:

`GET /v1/commitments?from=YYYY-MM-DD&to=YYYY-MM-DD`

```json
[{ "day": "2026-10-05", "commitment": "<hex>", "committedAt": "<ISO-8601>" }]
```

`GET /v1/stream/proof?from=<slot>&count=<1..100>` (slots that have not been produced are omitted)

```json
[{
  "slot": 179120161, "time": "2026-10-05T12:00:10Z", "digit": 7, "seed": "<hex>",
  "drandRound": 32799416, "drandRandomness": "<hex>", "drandSignature": "<hex>",
  "day": "2026-10-05", "commitment": "<hex>"
}]
```

A downloadable proof file has the shape `{ "protocol": "verylot/v1", "proofs": [...], "commitments": [...] }`.

## 7. Test vectors

`test-vectors/v1.json` covers:

- slot → day, index and round at both day boundaries;
- a full chain built from a fixed root, with seeds at index 0, 1, 4321 and 8639;
- valid and invalid seed checks;
- digits, including one where the first HMAC byte is ≥ 250.

Every input is derived from fixed labels (`tools/generate-vectors.cs`). The drand randomness in the vectors is
synthetic, so the vectors exercise the derivation and not BLS verification.

## 8. Versioning

The tags `verylot/chain/v1` and `verylot/digit/v1` name this version. A future v2 will use new tags and a new
proof `protocol` value. Days produced under v1 must stay verifiable with v1.
