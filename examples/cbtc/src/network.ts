/**
 * Where CBTC lives on each network, read from the committed registry capture.
 *
 * NOTHING HERE IS TYPED BY HAND. The admin party, the instrument id, the
 * decimals and the registry host all come from the raw responses CBTC's
 * registry returned on 2026-10-18, committed byte for byte under
 * `fixtures/registry/` with their SHA-256 in `fixtures/registry/provenance.json`,
 * which the tests check. An identity copied by hand is how a truncated admin
 * reaches a wallet.
 *
 * THESE ARE PINNED DEFAULTS, NOT THE TRUTH ON THE DAY YOU RUN THIS. BitSafe
 * states that CBTC's identifiers can change with DAR upgrades or migrations and
 * that nothing announces it
 * (https://docs.bitsafe.finance/developers/instrument-id-management.md).
 * `registry.ts` reads the registry at run time and says when it disagrees with
 * what is pinned here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The three networks the registry serves CBTC on. */
export const NETWORKS = ['mainnet', 'testnet', 'devnet'] as const;
export type Network = (typeof NETWORKS)[number];

/**
 * The opaque `executionScope.network` label a `0.2-draft` request carries.
 * The profile leaves the label to the requester (`ExecutionScope.network` in
 * `@payvol/core/draft02`); these labels are this example's own choice.
 */
export const SCOPE_LABEL: Record<Network, string> = {
  mainnet: 'canton-mainnet',
  testnet: 'canton-testnet',
  devnet: 'canton-devnet',
};

/** One network's CBTC identity, and where it was read from. */
export interface PinnedInstrument {
  readonly network: Network;
  /** The registry host, without the token-standard path. */
  readonly registryUrl: string;
  /** The registrar party, which is `instrumentId.admin`. */
  readonly admin: string;
  /** The instrument id within that registry. */
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
  /** When the registry said so. */
  readonly capturedUtc: string;
  /** The committed file this was read from, relative to this example's directory. */
  readonly source: string;
}

/** Where the capture lives, relative to this example's directory. */
export const CAPTURE_DIR = 'fixtures/registry';

/** This example's directory, from this module's own location (src/ or dist/). */
export const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Provenance {
  captures: { file: string; url: string; capturedUtc: string; httpStatus: number }[];
}

const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(join(EXAMPLE_DIR, CAPTURE_DIR, relative), 'utf8')) as unknown;

/** The token-standard path every registrar URL carries after the host. */
const TOKEN_STANDARD_PATH = '/api/token-standard/';

/**
 * Read one network's pinned CBTC identity from the capture.
 *
 * @throws if the capture does not say what this reads, rather than filling a
 * gap: a missing field is a broken fixture, not a default.
 */
export function pinned(network: Network): PinnedInstrument {
  const provenance = readJson('provenance.json') as Provenance;
  const file = `${network}-instruments.json`;
  const capture = provenance.captures.find((c) => c.file === file);
  if (capture === undefined || capture.httpStatus !== 200) {
    throw new Error(`no successful capture named ${file} in ${CAPTURE_DIR}/provenance.json`);
  }
  const cut = capture.url.indexOf(TOKEN_STANDARD_PATH);
  if (cut <= 0) throw new Error(`capture URL is not a token-standard URL: ${capture.url}`);

  const info = readJson(`${network}-info.json`) as { adminId?: unknown };
  const body = readJson(file) as { instruments?: unknown };
  const instruments = Array.isArray(body.instruments) ? body.instruments : [];
  const cbtc = instruments.find(
    (i): i is { id: string; symbol: string; decimals: number } =>
      typeof i === 'object' &&
      i !== null &&
      (i as { id?: unknown }).id === 'CBTC' &&
      typeof (i as { symbol?: unknown }).symbol === 'string' &&
      Number.isInteger((i as { decimals?: unknown }).decimals),
  );
  if (typeof info.adminId !== 'string' || cbtc === undefined) {
    throw new Error(`the ${network} capture does not carry an adminId and a CBTC instrument`);
  }
  return {
    network,
    registryUrl: capture.url.slice(0, cut),
    admin: info.adminId,
    id: cbtc.id,
    symbol: cbtc.symbol,
    decimals: cbtc.decimals,
    capturedUtc: capture.capturedUtc,
    source: `${CAPTURE_DIR}/${file}`,
  };
}

/** Which network a CBTC admin party belongs to, if it is one of the pinned three. */
export function networkOfAdmin(admin: string): Network | undefined {
  return NETWORKS.find((n) => pinned(n).admin === admin);
}

/** Read `NETWORK`, refusing anything that is not one of the three. */
export function parseNetwork(value: string | undefined): Network {
  if (value !== undefined && (NETWORKS as readonly string[]).includes(value)) {
    return value as Network;
  }
  throw new Error(
    `NETWORK must be one of ${NETWORKS.join(', ')}; got ${JSON.stringify(value)}. Set it in examples/cbtc/.env (copy .env.example) or the environment.`,
  );
}
