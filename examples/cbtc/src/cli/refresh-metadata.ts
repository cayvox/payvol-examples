/**
 * `npm run refresh-metadata`: ask the registry what CBTC is on NETWORK, now.
 *
 * Prints the resolved instrument and where it came from: the registry, the
 * last known good answer, or the pinned capture. Every disagreement with what
 * was held is a warning on stderr.
 */
import { context, warn } from './context.js';

const { network, pinned, resolved, registryUrl } = await context({ forceRefresh: true });
warn(resolved.warnings);
process.stdout.write(
  JSON.stringify(
    {
      network,
      registryUrl,
      source: resolved.source,
      fetchedAt: resolved.fetchedAt,
      instrument: resolved.metadata,
      pinnedFrom: pinned.source,
    },
    null,
    2,
  ) + '\n',
);
