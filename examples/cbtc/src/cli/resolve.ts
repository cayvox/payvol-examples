/**
 * `npm run resolve -- <instructionId> accept|reject|withdraw`
 *
 * Accept or reject an incoming CBTC offer as its receiver, or withdraw your
 * own as its sender, as PARTY_ID. The registry supplies the choice context;
 * the choice is exercised through the standard's TransferInstruction interface.
 */
import { disclosedFrom } from '../ledger.js';
import { choiceContext } from '../registry.js';
import { INTERFACES } from '../transfer.js';
import { context, ledgerFromEnv, record } from './context.js';

const [instructionId, which] = process.argv.slice(2);
if (!instructionId || (which !== 'accept' && which !== 'reject' && which !== 'withdraw')) {
  process.stderr.write('usage: resolve <instructionId> accept|reject|withdraw\n');
  process.exit(2);
}
const { ledger, party, keyFile, outDir } = ledgerFromEnv();
const { network, resolved, registryUrl } = await context();
const ctx = await choiceContext(
  fetch,
  registryUrl,
  resolved.metadata.admin,
  instructionId,
  which,
);
const choice = {
  accept: 'TransferInstruction_Accept',
  reject: 'TransferInstruction_Reject',
  withdraw: 'TransferInstruction_Withdraw',
}[which];
const command = {
  ExerciseCommand: {
    templateId: INTERFACES.transferInstruction,
    contractId: instructionId,
    choice,
    choiceArgument: { extraArgs: { context: ctx.choiceContextData, meta: { values: {} } } },
  },
};
const disclosed = disclosedFrom(ctx.disclosedContracts);
const done = keyFile
  ? await ledger.submitExternal(party, keyFile, command, disclosed)
  : await ledger.submitLocal(party, command, disclosed);
const file = record(outDir, `${which}-${done.updateId}.json`, {
  network,
  instructionId,
  result: done.raw,
});
process.stdout.write(
  JSON.stringify({ updateId: done.updateId, choice, recordedIn: file }, null, 2) + '\n',
);
