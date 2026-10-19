/**
 * `npm run instructions` lists the open CBTC transfer instructions PARTY_ID can
 * see, as their TransferInstruction views state them.
 */
import { context, ledgerFromEnv } from './context.js';

const { ledger, party } = ledgerFromEnv();
const { resolved } = await context();
const open = (await ledger.instructions(party)).filter(
  (i) =>
    (i.transfer['instrumentId'] as { admin?: string } | undefined)?.admin ===
    resolved.metadata.admin,
);
process.stdout.write(
  JSON.stringify(
    open.map((i) => ({
      instructionId: i.contractId,
      sender: i.transfer['sender'],
      receiver: i.transfer['receiver'],
      amount: i.transfer['amount'],
    })),
    null,
    2,
  ) + '\n',
);
