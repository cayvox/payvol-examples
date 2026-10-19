/**
 * `npm run pay -- '<canton: URI>' [--yes]`
 *
 * Pays a CBTC request as PARTY_ID: picks unlocked holdings, asks the registry
 * for the transfer factory, SHOWS the transfer, and signs only after the payer
 * confirms. `--yes` confirms in advance, for a non-interactive run you have
 * already reviewed. With PARTY_KEY_FILE set, PARTY_ID signs as an external party
 * (prepare, local Ed25519 signature, execute); without it, as a party hosted on
 * the participant.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { disclosedFrom } from '../ledger.js';
import { transferFactory } from '../registry.js';
import {
  executeBefore,
  INTERFACES,
  payableRequest,
  review,
  selectHoldings,
  transferChoiceArgs,
} from '../transfer.js';
import { context, ledgerFromEnv, record, warn } from './context.js';

const { values, positionals } = parseArgs({
  options: { yes: { type: 'boolean', default: false } },
  allowPositionals: true,
  strict: true,
});
const uri = positionals[0];
if (uri === undefined) {
  process.stderr.write("usage: pay '<canton: URI>' [--yes]\n");
  process.exit(2);
}

const { ledger, party, keyFile, outDir } = ledgerFromEnv();
const { network, resolved, registryUrl } = await context();
warn(resolved.warnings);
const now = new Date();

const payable = payableRequest(uri, resolved.metadata, now);
if (!payable.ok) {
  process.stderr.write(`refused: ${payable.reason}\n`);
  process.exit(1);
}
const request = payable.request;
const picked = selectHoldings(
  await ledger.holdings(party),
  resolved.metadata,
  party,
  request.amount!,
);
if (!picked.ok) {
  process.stderr.write(`refused: ${picked.reason}\n`);
  process.exit(1);
}
const plan = {
  request,
  sender: party,
  inputs: picked.contractIds,
  requestedAt: now.toISOString(),
  executeBefore: executeBefore(request, now),
};
const factory = await transferFactory(
  fetch,
  registryUrl,
  resolved.metadata.admin,
  transferChoiceArgs(plan),
);
const args = transferChoiceArgs(plan, factory.choiceContextData);

process.stdout.write(
  review(args, network) + `\n  registry says  ${factory.transferKind ?? 'no transfer kind'}\n`,
);
if (!values.yes) {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'refused: not signing without a confirmation. Re-run in a terminal, or with --yes after reviewing.\n',
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Sign and submit this transfer? Type "yes": ');
  rl.close();
  if (answer.trim() !== 'yes') {
    process.stderr.write('not signed.\n');
    process.exit(1);
  }
}

const command = {
  ExerciseCommand: {
    templateId: INTERFACES.transferFactory,
    contractId: factory.factoryId,
    choice: 'TransferFactory_Transfer',
    choiceArgument: args,
  },
};
const disclosed = disclosedFrom(factory.disclosedContracts);
const done = keyFile
  ? await ledger.submitExternal(party, keyFile, command, disclosed)
  : await ledger.submitLocal(party, command, disclosed);
const file = record(outDir, `pay-${done.updateId}.json`, {
  network,
  transferKind: factory.transferKind,
  args,
  result: done.raw,
});
process.stdout.write(
  JSON.stringify(
    { updateId: done.updateId, transferKind: factory.transferKind, recordedIn: file },
    null,
    2,
  ) + '\n',
);
