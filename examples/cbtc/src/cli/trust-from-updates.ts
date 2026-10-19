/**
 * `npm run trust-from-updates -- <offerUpdateId> <acceptUpdateId>`
 *
 * Derives a TransferTrustPolicy from one offer and its acceptance, read as
 * PARTY_ID on your own participant, and writes it to the output directory
 * (gitignored). Review it before trusting it: it names exactly the templates
 * your ledger reported for this registry today.
 */
import { trustFromUpdates } from '../observe.js';
import { context, ledgerFromEnv, record } from './context.js';

const [offerId, acceptId] = process.argv.slice(2);
if (!offerId || !acceptId) {
  process.stderr.write('usage: trust-from-updates <offerUpdateId> <acceptUpdateId>\n');
  process.exit(2);
}
const { ledger, party, outDir } = ledgerFromEnv();
const { network } = await context();
const derived = trustFromUpdates(
  await ledger.updateById(offerId, party),
  await ledger.updateById(acceptId, party),
);
if (!derived.ok) {
  process.stderr.write(`refused: ${derived.reason}\n`);
  process.exit(1);
}
const file = record(outDir, `trust-${network}.json`, derived.trust);
process.stdout.write(`wrote ${file}\n`);
