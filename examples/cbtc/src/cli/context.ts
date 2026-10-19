/**
 * What every script needs before it does anything: the network, the
 * instrument as the registry says it is today, and the last answer it gave.
 *
 * Configuration comes from the environment, and from `examples/cbtc/.env` when
 * that file exists (gitignored; `.env.example` lists the names). Nothing here
 * takes a secret: the offline scripts read a public registry and nothing else.
 *
 * Every script imports this module, so a failure in any of them is reported
 * here as one line on stderr and exit code 1, not as a stack trace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNetwork, pinned, type Network, type PinnedInstrument } from '../network.js';
import { isFresh, resolveInstrument, type Resolved } from '../registry.js';
import { Ledger, LedgerError } from '../ledger.js';

/** One line for a failure: its message, what caused it, and a ledger's answer if there was one. */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  let line = error.message;
  const causes: string[] = [];
  for (let c = error.cause; c instanceof Error && causes.length < 3; c = c.cause) {
    if (c.message !== '') causes.push(c.message);
  }
  if (causes.length > 0) line += ` (${causes.join(': ')})`;
  if (error instanceof LedgerError && error.body !== null && error.body !== '') {
    const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
    line += `: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}`;
  }
  return line;
}

const fail = (error: unknown): never => {
  process.stderr.write(`error: ${describeFailure(error)}\n`);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/** `examples/cbtc`, from this module's own location (src/cli or dist/cli). */
export const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse `KEY=value` lines. No interpolation, no quotes and no `export`. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** The environment, with `examples/cbtc/.env` underneath it when present. */
export function loadEnv(): Record<string, string | undefined> {
  const file = join(EXAMPLE, '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

/**
 * Where the last registry answer is kept between runs (gitignored).
 *
 * Keyed by the registry and admin it came from when either is overridden, so
 * an answer from one registry is never reused as another's.
 */
const cacheFile = (network: Network, override?: string): string =>
  join(
    EXAMPLE,
    'out',
    override === undefined
      ? `metadata-${network}.json`
      : `metadata-${network}-${createHash('sha256').update(override).digest('hex').slice(0, 12)}.json`,
  );

function readCache(file: string): Resolved | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Resolved;
  } catch {
    return undefined;
  }
}

/** Everything a script runs against. */
export interface Context {
  readonly network: Network;
  readonly pinned: PinnedInstrument;
  readonly resolved: Resolved;
  /** The registry every call uses: `REGISTRY_URL` when set, else the pinned one. */
  readonly registryUrl: string;
}

/**
 * Resolve the network and the instrument, refreshing from the registry unless
 * the last answer is inside the refresh window. `REGISTRY_URL` and
 * `CBTC_ADMIN` override the pinned values, for a registry that has moved.
 */
export async function context(options: { forceRefresh?: boolean } = {}): Promise<Context> {
  const env = loadEnv();
  const network = parseNetwork(env['NETWORK']);
  const pin = pinned(network);
  const registryUrl = env['REGISTRY_URL'] || pin.registryUrl;
  const overridden = Boolean(env['REGISTRY_URL'] || env['CBTC_ADMIN']);
  const file = cacheFile(network, overridden ? `${registryUrl}|${env['CBTC_ADMIN'] ?? ''}` : undefined);
  const cached = readCache(file);
  const now = new Date();

  if (!options.forceRefresh && cached !== undefined && isFresh(cached, now)) {
    return { network, pinned: pin, resolved: { ...cached, warnings: [] }, registryUrl };
  }
  const resolved = await resolveInstrument({
    pinned: pin,
    registryUrl,
    ...(env['CBTC_ADMIN'] ? { admin: env['CBTC_ADMIN'] } : {}),
    ...(cached === undefined ? {} : { lastKnownGood: cached }),
    fetch,
    now,
  });
  if (resolved.source === 'registry') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...resolved, warnings: [] }, null, 2) + '\n');
  }
  return { network, pinned: pin, resolved, registryUrl };
}

/** Print warnings to stderr, one per line, so stdout stays the artifact. */
export function warn(lines: readonly string[]): void {
  for (const line of lines) process.stderr.write(`warning: ${line}\n`);
}

/** The participant and the acting party, from the environment. Nothing secret is printed. */
export function ledgerFromEnv(): {
  ledger: Ledger;
  party: string;
  keyFile?: string;
  outDir: string;
} {
  const env = loadEnv();
  const baseUrl = env['LEDGER_API_URL'];
  const party = env['PARTY_ID'];
  if (!baseUrl || !party) {
    throw new Error(
      'this script talks to your participant: set LEDGER_API_URL and PARTY_ID in examples/cbtc/.env or the environment (see .env.example)',
    );
  }
  const keyFile = env['PARTY_KEY_FILE'] || undefined;
  return {
    ledger: new Ledger({
      baseUrl,
      userId: env['LEDGER_USER_ID'] || 'ledger-api-user',
      ...(env['LEDGER_TOKEN_FILE'] ? { tokenFile: env['LEDGER_TOKEN_FILE'] } : {}),
    }),
    party,
    ...(keyFile ? { keyFile } : {}),
    outDir: env['PAYVOL_OUT_DIR'] || join(EXAMPLE, 'out'),
  };
}

/** Write a JSON record into the output directory (gitignored by default). */
export function record(outDir: string, name: string, data: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}
