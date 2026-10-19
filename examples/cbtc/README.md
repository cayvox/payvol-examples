# Payvol with CBTC

Build a CBTC payment request, read it back the way a payer's wallet would, and check both against
what CBTC's registry says CBTC is today. Then, with your own participant, pay the request, accept
or reject the offer it creates, and observe the payment.

The example uses the published [`@payvol/core`](https://www.npmjs.com/package/@payvol/core) and
[`@payvol/qr`](https://www.npmjs.com/package/@payvol/qr) packages, and reaches CBTC only through
the public Canton Token Standard (CIP-0056) interfaces and the registry's public HTTP API.

## What needs what

| Script | Needs | Network calls |
|---|---|---|
| `npm test` | nothing | none: every registry answer is a committed capture |
| `refresh-metadata` | `NETWORK` | unauthenticated `GET` to CBTC's public registry |
| `create-request` | `NETWORK` | the same `GET`, unless the last answer is under ten minutes old |
| `verify-request` | `NETWORK` | the same as `create-request` |
| `pay` | `NETWORK`, a participant (`LEDGER_API_URL`, `PARTY_ID`), CBTC to spend | your JSON Ledger API, and a `POST` to the registry's transfer factory |
| `instructions` | `NETWORK`, a participant | your JSON Ledger API |
| `resolve` | `NETWORK`, a participant | your JSON Ledger API, and a `POST` to the registry's choice context |
| `trust-from-updates` | `NETWORK`, a participant | your JSON Ledger API |
| `observe` | `NETWORK`, a participant, a trust policy | your JSON Ledger API |

The first four need no account, no key and no funds. If the registry cannot be reached, they still
run, on the last answer the registry gave or, failing that, on the committed capture, and they
say so on stderr.

## Before you start

- Node.js `20.19.0` or later, with the npm that ships with it.
- A terminal in this directory, `examples/cbtc`, of a clone of this repository.

## Install, test, build

```sh
npm install
npm test
npm run build
```

`npm install` takes the packages from the public npm registry, at the versions in
`package-lock.json`, and `npm audit` reports no known vulnerabilities for them on 2026-10-19. npm
may print a note that `esbuild` (and, on macOS, `fsevents`) have install scripts. The example's
runtime dependencies are `@payvol/core`, `@payvol/qr` and `qrcode`.

`npm test` runs the offline tests. The end of its output reads:

```
 Test Files  2 passed (2)
      Tests  56 passed (56)
```

Three of them check the identifiers in [`docs/cbtc-guide.md`](../../docs/cbtc-guide.md) against the
committed capture, so the guide cannot drift from what the registry said.

`npm run build` compiles `src/` to `dist/`. Every script below runs from `dist/`, so build again
after you change the source.

Then create your configuration:

```sh
cp .env.example .env
```

`.env` sets `NETWORK=testnet`. The other two values are `mainnet` and `devnet`, in lowercase. Each
line is `KEY=value`, with no quotes and no `export`. A variable set in your shell overrides the
same name in `.env`, so `NETWORK=devnet npm run refresh-metadata` works without editing the file.

npm prints a two-line header, `> @payvol/example-cbtc@0.0.0 <script>`, before each script's own
output. Add `-s` (`npm run -s refresh-metadata`) to leave it out, for example when you pipe the
JSON somewhere.

## 1. Ask the registry what CBTC is

```sh
npm run refresh-metadata
```

```json
{
  "network": "testnet",
  "registryUrl": "https://api.utilities.digitalasset-staging.com",
  "source": "registry",
  "fetchedAt": "2026-10-19T16:44:41.330Z",
  "instrument": {
    "admin": "cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f",
    "id": "CBTC",
    "symbol": "CBTC",
    "decimals": 10,
    "paused": false
  },
  "pinnedFrom": "fixtures/registry/testnet-instruments.json"
}
```

That is a TestNet run on 2026-10-19. `fetchedAt` is the time of your run. `source` says where the
instrument came from:

- `registry`: the registry answered just now;
- `last-known-good`: the registry could not be read, so the last answer it gave, kept in
  `out/metadata-<network>.json`, was used;
- `pinned`: neither was available, so the committed capture was used.

The last two come with a `warning:` line on stderr that says why. `refresh-metadata` always asks
the registry. The other scripts reuse an answer that is under ten minutes old.

## 2. Build a request

`--recipient` is the party being paid, `--amount` is in CBTC, and `--expiry` is an RFC 3339 time
in the future after which the request is no longer payable. The recipient below is a well-formed
placeholder: replace it with the payee's real party id.

```sh
npm run create-request -- \
  --recipient payvol-demo-recipient::1220abababababababababababababababababababababababababababababababab \
  --amount 0.0013567821 --expiry 2027-01-01T00:00:00Z --reference INV-CBTC-0001 --qr
```

The `--` separates npm's options from the script's. The script prints:

```json
{
  "network": "testnet",
  "instrumentFrom": "registry",
  "uri": "canton:payvol-demo-recipient%3A%3A1220abababababababababababababababababababababababababababababababab?instrument=cbtc-network%3A%3A12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f%2FCBTC&amount=0.0013567821&reference=INV-CBTC-0001&expiry=2027-01-01T00%3A00%3A00Z",
  "link": "web+canton:payvol-demo-recipient%3A%3A1220abababababababababababababababababababababababababababababababab?instrument=cbtc-network%3A%3A12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f%2FCBTC&amount=0.0013567821&reference=INV-CBTC-0001&expiry=2027-01-01T00%3A00%3A00Z",
  "digest": "c838d226c7892ea878ddcc87a2a1e06d99ca1c8adfe835c9506e565600f4c663"
}
```

- `uri` is the request as a `canton:` URI.
- `link` is the same request as a `web+canton:` link, the form a browser can register a handler
  for.
- `digest` is the SHA-256 of the request's canonical JSON (RFC 8785). The same request always has
  the same digest.

With `--qr` it then draws a QR code of the URI in the terminal. `--label <text>` adds a label.
Leave out `--qr` to get the JSON alone.

An amount with more fractional digits than the registry gives CBTC is refused, not rounded, and
the script exits `1`:

```sh
npm run create-request -- \
  --recipient payvol-demo-recipient::1220abababababababababababababababababababababababababababababababab \
  --amount 0.00135678211 --expiry 2027-01-01T00:00:00Z
```

```
refused: AMOUNT_BEYOND_DECIMALS: amount 0.00135678211 has 11 fractional digits; the registry gives this instrument 10
```

## 3. Read the request back

Pass the `uri` from step 2 **in single quotes**. It contains `?` and `&`, which your shell would
otherwise act on.

```sh
npm run verify-request -- 'canton:payvol-demo-recipient%3A%3A1220abababababababababababababababababababababababababababababababab?instrument=cbtc-network%3A%3A12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f%2FCBTC&amount=0.0013567821&reference=INV-CBTC-0001&expiry=2027-01-01T00%3A00%3A00Z'
```

```json
{
  "network": "testnet",
  "valid": true,
  "request": {
    "version": "0.1",
    "type": "transfer",
    "recipient": "payvol-demo-recipient::1220abababababababababababababababababababababababababababababababab",
    "instrument": "cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f/CBTC",
    "amount": "0.0013567821",
    "reference": "INV-CBTC-0001",
    "expiry": "2027-01-01T00:00:00Z"
  },
  "warnings": []
}
```

It exits `0` when the request reads as CBTC on `NETWORK`, and `1` when it is refused. Warnings
alone do not refuse a request. The same URI read on another network is refused, because each
network's CBTC has its own registrar:

```sh
NETWORK=mainnet npm run verify-request -- 'canton:payvol-demo-recipient%3A%3A1220abababababababababababababababababababababababababababababababab?instrument=cbtc-network%3A%3A12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f%2FCBTC&amount=0.0013567821&reference=INV-CBTC-0001&expiry=2027-01-01T00%3A00%3A00Z'
```

It prints the same JSON as above, except:

```
  "network": "mainnet",
  "valid": false,
  "refusal": "NOT_THIS_NETWORK: the instrument admin is CBTC's testnet registrar, and this is mainnet",
```

### What the checks mean

| You see | It means |
|---|---|
| `refused: AMOUNT_BEYOND_DECIMALS` from `create-request` | The amount has more fractional digits than the registry gives CBTC (10 on 2026-10-18). It is refused, not rounded, because a rounded amount is a different request. |
| `AMOUNT_BEYOND_DECIMALS` as a warning from `verify-request` | The same finding on a request someone else built. Reading it back warns rather than refuses. |
| `NOT_THIS_NETWORK` | The instrument is CBTC on another network. The three networks' identities are never mixed. |
| `ADMIN_NOT_CBTC_REGISTRAR` | Something calls itself `CBTC` under a party that is not CBTC's registrar on this network. |
| `NOT_CBTC` | The request is for another instrument altogether. |
| `INSTRUMENT_PAUSED` | The registry reports CBTC as paused. |
| `RECIPIENT_NOT_A_PARTY_ID`, `INSTRUMENT_ADMIN_NOT_A_PARTY_ID` | `@payvol/core`'s own warnings: the request is well formed, but a party in it is not a full Canton party id, so no network could settle it. |
| `warning: the registry could not be read …` | The run used the last known answer or the capture, and names which. |

## Where CBTC's identity comes from

Nothing in this example is typed by hand.

- **Pinned defaults.** The registry URL, admin party, instrument id and decimals for each network
  are read at run time from the registry's own responses, captured on 2026-10-18 and committed
  byte for byte under [`fixtures/registry/`](fixtures/registry/). `provenance.json` there records
  each response's URL, capture time, HTTP status and SHA-256, and `npm test` fails if a capture no
  longer matches its hash. The admin parties and registry URLs are the ones BitSafe publishes in
  [Instrument ID Management](https://docs.bitsafe.finance/developers/instrument-id-management.md).
- **Every run.** `/registry/metadata/v1/info` and `/registry/metadata/v1/instruments` are read
  again for the CBTC registrar on `NETWORK`. The answer is checked field by field before it is
  used.
- **When the registry says something different, you get a warning.** That is how a changed id,
  admin or decimals is noticed. BitSafe states that the admin and id can change with upgrades or
  migrations, and that nothing announces it.
- **When the registry cannot be read,** the last answer it gave is used, and failing that the
  capture. Each says which on stderr. The example waits 95 seconds for an answer, a choice that
  matches BitSafe's note that cbtc-lib retries an unreachable registry for about 90 seconds
  ([Compatibility and release notes](https://docs.bitsafe.finance/cbtc/concepts-and-reference/compatibility-and-release-notes.md)).

`REGISTRY_URL` and `CBTC_ADMIN` in `.env` override the pinned registry and admin, for when either
has moved. `CBTC_ADMIN` must be a full party id, `name::1220` followed by 64 hex characters.

## 4. Pay, accept, observe (needs a participant)

These scripts talk to your own participant's JSON Ledger API. Set, in `.env`:

| Variable | Set it to |
|---|---|
| `LEDGER_API_URL` | Your participant's JSON Ledger API, for example `http://127.0.0.1:7575`. |
| `PARTY_ID` | The party that acts: the payer for `pay` and `resolve … withdraw`, the payee for `instructions`, `resolve … accept`/`reject`, `trust-from-updates` and `observe`. |
| `PARTY_KEY_FILE` | Only if `PARTY_ID` is an external party: the path to its Ed25519 private key (PEM). It is read to sign locally and is never sent or printed. Without it, the party submits as a party hosted on the participant. |
| `LEDGER_TOKEN_FILE` | Only if your participant requires auth: a file holding the bearer token. It is never printed. |
| `LEDGER_USER_ID` | The participant user the commands are submitted as. Defaults to `ledger-api-user`. |
| `PAYVOL_OUT_DIR` | Where records and the trust policy are written. Defaults to `out/` here (gitignored). |

Without `LEDGER_API_URL` and `PARTY_ID`, each of these scripts stops before it contacts anything:

```
error: this script talks to your participant: set LEDGER_API_URL and PARTY_ID in examples/cbtc/.env or the environment (see .env.example)
```

Test CBTC on DevNet and TestNet is available by party id from BitSafe's faucet,
<https://cbtc-faucet.bitsafe.finance/>. If it arrives as an offer, accept it with `resolve`
(below).

In the order you would run them:

```sh
npm run pay -- '<the canton: URI>'                          # as the payer
npm run instructions                                        # as the payee: the open offers you can see
npm run resolve -- <instructionId> accept                   # as the payee; or reject. The payer can withdraw.
npm run trust-from-updates -- <offerUpdateId> <acceptUpdateId>   # once, as the payee
npm run observe -- '<the canton: URI>' <offerUpdateId> <acceptUpdateId>   # as the payee
```

**`pay`** works in four steps:

1. It reads the request and refuses it if this network's CBTC cannot pay it: an invalid or
   expired request, a warning from `validate()`, another instrument, no amount, too many decimals,
   or a paused instrument.
2. It picks unlocked CBTC holdings of `PARTY_ID`, largest first, until they cover the amount, and
   asks the registry for the transfer factory.
3. It **prints the transfer command it will submit**: amount, registrar, both parties in full, the
   deadline and the metadata.
4. It signs only after you type `yes`. Without a terminal it refuses unless you pass `--yes`
   (`npm run pay -- '<uri>' --yes`), which you should do only after reading that output.

For an external party (`PARTY_KEY_FILE`), your participant prepares the transaction from that
command and `pay` signs the hash the participant returns. The example does not decode the prepared
transaction or recompute its hash, so it trusts your own participant to prepare exactly what you
reviewed. Verify the prepared transaction before signing if you build on this for real funds.

It then prints the `updateId` and writes the full result to `out/pay-<updateId>.json`. The
deadline is the request's expiry or 24 hours from now, whichever is sooner. The transfer carries
three metadata values: `splice.lfdecentralizedtrust.org/reason` (the request's reference, the
Token Standard's reason key), `payvol.xyz/request-digest` (the digest from step 2) and
`payvol.xyz/profile`. Whoever can read the transfer can read them.

**`instructions`** prints the open CBTC transfer instructions `PARTY_ID` can see, each with its
`instructionId`, sender, receiver and amount.

**`resolve <instructionId> accept|reject|withdraw`** exercises that choice on the instruction
through the standard's `TransferInstruction` interface, with the choice context the registry
supplies. It prints the `updateId` and writes `out/<choice>-<updateId>.json`.

**`trust-from-updates <offerUpdateId> <acceptUpdateId>`** derives a trust policy from one offer and
its acceptance, read on your own participant, and writes it to `out/trust-<network>.json`.

**This example ships no trust policy.** A trust policy names the registry's own templates and
package ids. Those differ per network and change with upgrades, so they are yours to read, not
ours to guess. `trust-from-updates` matches events only by the public Token Standard interface
names and records whatever concrete ids your ledger reports. Read the policy before you rely on it.

**`observe '<uri>' <offerUpdateId> [<resolvingUpdateId>] [--trust <file>]`** reads the offer, and
the update that resolved it, with that policy (default `out/trust-<network>.json`). It prints the
offer's and the outcome's lifecycle (`offered`, `settled`, `rejected`, `withdrawn` or `unknown`) and four checks
against the request:

- the digest;
- the receiver;
- the instrument;
- whether the credited amount covers the request.

A rejected or withdrawn offer reads as that, never as a payment.

**Not covered:** a payment that settles on submission, for example because the payee pre-approved
the payer, creates no offer, and `observe` cannot record it yet.

## Troubleshooting

- **`NETWORK must be one of mainnet, testnet, devnet`.** Create `.env` from `.env.example`, or set
  `NETWORK`, in lowercase.
- **`Error: Cannot find module '…/dist/cli/…'`.** Run `npm run build` first.
- **A long pause, then a fallback warning.** The registry did not answer within 95 seconds. The
  result is still usable, and it says which value it used.
- **`not a full party id`.** `CBTC_ADMIN` must be a whole party, `name::1220` plus 64 hex
  characters.
- **`refused: no trust policy at …`.** Run `trust-from-updates` first, or pass `--trust <file>`
  to `observe`.

## Sources

- BitSafe, [Instrument ID Management](https://docs.bitsafe.finance/developers/instrument-id-management.md):
  the registry URL and admin party per network, and the refresh guidance this example follows.
- BitSafe, [Compatibility and release notes](https://docs.bitsafe.finance/cbtc/concepts-and-reference/compatibility-and-release-notes.md):
  cbtc-lib's 90-second registry retries, and the JSON Ledger API request shapes Canton 3.6.1 accepts.
- BitSafe, [Transfer and receive CBTC](https://docs.bitsafe.finance/cbtc/guides/transfer-and-receive-cbtc.md):
  offers, acceptance, and transfers that settle on submission.
- The Canton Token Standard (CIP-0056) interfaces, `splice-api-token-*`, in the
  [Splice repository](https://github.com/canton-network/splice) (formerly `hyperledger-labs/splice`).
