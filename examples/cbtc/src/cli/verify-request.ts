/**
 * `npm run verify-request -- '<canton: URI>'`
 *
 * Reads a request back as a payer's wallet would, against CBTC on NETWORK: does
 * it validate, is the instrument this network's CBTC, does the amount fit its
 * decimals. Exits 1 when the request is refused; warnings alone exit 0.
 */
import { verifyRequest } from '../request.js';
import { context, warn } from './context.js';

const uri = process.argv[2];
if (uri === undefined) {
  process.stderr.write('usage: verify-request <canton: URI>\n');
  process.exit(2);
}
const { network, resolved } = await context();
warn(resolved.warnings);
const verdict = verifyRequest(uri, network, resolved.metadata);
process.stdout.write(JSON.stringify({ network, ...verdict }, null, 2) + '\n');
process.exit(verdict.valid ? 0 : 1);
