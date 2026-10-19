/**
 * `npm run observe -- '<canton: URI>' <offerUpdateId> [<resolvingUpdateId>] [--trust <file>]`
 *
 * Reads the offer, and the update that resolved it, as PARTY_ID (the payee),
 * and checks what settled against the request: digest, receiver, instrument,
 * amount. The trust policy defaults to out/trust-<NETWORK>.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decode } from '@payvol/core';
import type { TransferPayvol } from '@payvol/core';
import { observePayment, parseTrust } from '../observe.js';
import { context, ledgerFromEnv } from './context.js';

const { values, positionals } = parseArgs({
  options: { trust: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});
const [uri, offerId, resolvingId] = positionals;
if (!uri || !offerId) {
  process.stderr.write(
    "usage: observe '<canton: URI>' <offerUpdateId> [<resolvingUpdateId>] [--trust <file>]\n",
  );
  process.exit(2);
}
const { ledger, party, outDir } = ledgerFromEnv();
const { network } = await context();
const trustFile = values.trust ?? join(outDir, `trust-${network}.json`);
if (!existsSync(trustFile)) {
  process.stderr.write(
    `refused: no trust policy at ${trustFile}. Derive one with trust-from-updates, or pass --trust <file>.\n`,
  );
  process.exit(1);
}
const trust = parseTrust(JSON.parse(readFileSync(trustFile, 'utf8')));
if (!trust.ok) {
  process.stderr.write(`refused: ${trust.reason}\n`);
  process.exit(1);
}
const request = decode(uri) as TransferPayvol;
const observed = observePayment({
  request,
  offerUpdate: await ledger.updateById(offerId, party),
  ...(resolvingId ? { resolvingUpdate: await ledger.updateById(resolvingId, party) } : {}),
  trust: trust.trust,
  observedAt: new Date().toISOString(),
});
const lifecycle = (r: unknown) =>
  r && typeof r === 'object' && 'lifecycle' in r ? (r as { lifecycle: string }).lifecycle : r;
process.stdout.write(
  JSON.stringify(
    {
      network,
      offer: lifecycle(observed.offer),
      outcome: lifecycle(observed.outcome),
      checks: observed.checks,
    },
    null,
    2,
  ) + '\n',
);
