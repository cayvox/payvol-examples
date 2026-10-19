/**
 * `npm run create-request -- --recipient <party> --amount <decimal> --expiry <RFC 3339>
 *  [--reference <id>] [--label <text>] [--qr]`
 *
 * Builds a CBTC request on NETWORK and prints it as a URI, a `web+canton:` link
 * and its digest. `--qr` also draws the QR in the terminal. An amount with more
 * fractional digits than the registry gives CBTC is refused, never rounded.
 */
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { buildRequest } from '../request.js';
import { context, warn } from './context.js';

const { values } = parseArgs({
  options: {
    recipient: { type: 'string' },
    amount: { type: 'string' },
    expiry: { type: 'string' },
    reference: { type: 'string' },
    label: { type: 'string' },
    qr: { type: 'boolean', default: false },
  },
  strict: true,
});
for (const required of ['recipient', 'amount', 'expiry'] as const) {
  if (values[required] === undefined) {
    process.stderr.write(`--${required} is required\n`);
    process.exit(2);
  }
}

const { network, resolved } = await context();
warn(resolved.warnings);
try {
  const built = buildRequest(
    {
      recipient: values.recipient!,
      amount: values.amount!,
      expiry: values.expiry!,
      ...(values.reference === undefined ? {} : { reference: values.reference }),
      ...(values.label === undefined ? {} : { label: values.label }),
    },
    resolved.metadata,
  );
  warn(built.warnings);
  process.stdout.write(
    JSON.stringify(
      {
        network,
        instrumentFrom: resolved.source,
        uri: built.uri,
        link: built.link,
        digest: built.digest,
      },
      null,
      2,
    ) + '\n',
  );
  if (values.qr) {
    const qr = await QRCode.toString(built.qr, { type: 'terminal', small: true });
    /* The terminal rendering ends without a newline; add one so the prompt starts below it. */
    process.stdout.write(qr.endsWith('\n') ? qr : `${qr}\n`);
  }
} catch (error) {
  process.stderr.write(`refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
