/**
 * Read CBTC's identity from its registry, and say when it disagrees with what
 * we held.
 *
 * BitSafe's guidance (https://docs.bitsafe.finance/developers/instrument-id-management.md,
 * "Recommended Polling Pattern"): fetch on startup, refresh every 5 to 15
 * minutes, warn when the id changes, keep the last known good value when a
 * fetch fails. This module follows it with one deviation: the command-line
 * scripts are short-lived, so they reuse an answer under ten minutes old
 * instead of fetching on every start (`refresh-metadata` always fetches). It
 * reads a public registry; it holds no key and calls nothing that writes.
 *
 * Two reads, because each answers a different question:
 *
 *  - `/registry/metadata/v1/info` names the registrar. Its `adminId` must equal
 *    the admin in the URL, which is how the 2026-10-18 capture established that
 *    the published party is the registry's own.
 *  - `/registry/metadata/v1/instruments` says what the instrument is: id,
 *    symbol, decimals, and whether it is paused.
 *
 * Everything that comes back is untrusted input and is checked field by field
 * before it is used.
 */
import type { PinnedInstrument } from './network.js';

/** A full party id, `name::1220` plus 64 hex characters: the rule `@payvol/core`'s `validate()` applies. */
const FULL_PARTY_ID = /^[A-Za-z0-9_-]+::1220[0-9a-f]{64}$/;

/**
 * A design choice of this example. BitSafe's release notes say that cbtc-lib
 * retries four registry routes and that an unreachable registry then fails
 * after about 90 seconds, and they advise a caller timeout above that
 * (https://docs.bitsafe.finance/cbtc/concepts-and-reference/compatibility-and-release-notes.md).
 * This example does not use cbtc-lib; it waits 95 seconds to match that
 * behaviour.
 */
export const REGISTRY_TIMEOUT_MS = 95_000;

/** Ten minutes, inside BitSafe's 5 to 15. */
export const REFRESH_AFTER_MS = 10 * 60_000;

/** What the registry says about the instrument, after checking. */
export interface InstrumentMetadata {
  readonly admin: string;
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly paused: boolean;
}

/** A metadata URL for one registrar. The admin is refused unless it is a full party. */
export function metadataUrl(
  registryUrl: string,
  admin: string,
  which: 'info' | 'instruments',
): string {
  /* The admin goes into the path, so a value with `/`, `?` or `#` would point
     the request somewhere else. The capture used the party unencoded and the
     registry answered 200; a full party id has no character that needs it. */
  if (!FULL_PARTY_ID.test(admin)) throw new Error(`not a full party id: ${JSON.stringify(admin)}`);
  if (!/^https:\/\/[^/?#]+$/.test(registryUrl)) {
    throw new Error(`registry URL must be an https origin with no path: ${registryUrl}`);
  }
  return `${registryUrl}/api/token-standard/v0/registrars/${admin}/registry/metadata/v1/${which}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check the two response bodies and return the instrument, or say exactly
 * what was wrong with them.
 */
export function parseMetadata(
  admin: string,
  id: string,
  info: unknown,
  instruments: unknown,
): { ok: true; metadata: InstrumentMetadata } | { ok: false; reason: string } {
  if (!isRecord(info) || info['adminId'] !== admin) {
    return { ok: false, reason: `/info does not name ${admin} as its admin` };
  }
  if (!isRecord(instruments) || !Array.isArray(instruments['instruments'])) {
    return { ok: false, reason: '/instruments carries no instruments array' };
  }
  const found = instruments['instruments'].find((i) => isRecord(i) && i['id'] === id);
  if (!isRecord(found)) {
    /* A next page could hold it. The page-token query parameter is not
       something this example has verified, so it says so rather than
       guessing a parameter name. */
    const more =
      instruments['nextPageToken'] !== null && instruments['nextPageToken'] !== undefined;
    return {
      ok: false,
      reason: more
        ? `no instrument ${id} on the first page, and following pages is not implemented`
        : `the registrar lists no instrument ${id}`,
    };
  }
  const { symbol, decimals, paused } = found;
  if (typeof symbol !== 'string' || symbol === '') {
    return { ok: false, reason: 'symbol is missing' };
  }
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    return { ok: false, reason: 'decimals is not a non-negative integer' };
  }
  if (typeof paused !== 'boolean') return { ok: false, reason: 'paused is not a boolean' };
  return { ok: true, metadata: { admin, id, symbol, decimals, paused } };
}

/** What `fetch` this module needs, so tests can replay the capture without a network. */
export type Fetch = (
  url: string,
  init: { signal: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The instrument this run will use, where it came from, and anything worth saying about it. */
export interface Resolved {
  readonly metadata: InstrumentMetadata;
  readonly source: 'registry' | 'last-known-good' | 'pinned';
  readonly fetchedAt: string | null;
  readonly warnings: readonly string[];
}

/** Has the registry said something different from what we held? */
export function differences(held: InstrumentMetadata, now: InstrumentMetadata): string[] {
  const out: string[] = [];
  for (const k of ['admin', 'id', 'symbol', 'decimals', 'paused'] as const) {
    if (held[k] !== now[k]) {
      out.push(`${k} changed: ${JSON.stringify(held[k])} -> ${JSON.stringify(now[k])}`);
    }
  }
  return out;
}

/** The pinned identity, as metadata. A pinned instrument is never recorded as paused. */
export function fromPinned(p: PinnedInstrument): InstrumentMetadata {
  return { admin: p.admin, id: p.id, symbol: p.symbol, decimals: p.decimals, paused: false };
}

/**
 * Resolve the instrument for this run.
 *
 * - A fresh registry answer wins, with a warning for every field that differs
 *   from what was held (the last known good, or the pinned capture).
 * - If the registry cannot be read, the last known good value is used, and
 *   failing that the pinned capture. Each says so in `warnings`: a run on a
 *   stale identity must know it is one.
 * - A paused instrument is reported, never hidden.
 */
export async function resolveInstrument(input: {
  pinned: PinnedInstrument;
  registryUrl?: string;
  admin?: string;
  lastKnownGood?: Resolved;
  fetch: Fetch;
  now: Date;
  timeoutMs?: number;
}): Promise<Resolved> {
  const registryUrl = input.registryUrl ?? input.pinned.registryUrl;
  const admin = input.admin ?? input.pinned.admin;
  const held = input.lastKnownGood?.metadata ?? fromPinned(input.pinned);
  const timeoutMs = input.timeoutMs ?? REGISTRY_TIMEOUT_MS;

  const read = async (which: 'info' | 'instruments'): Promise<unknown> => {
    const response = await input.fetch(metadataUrl(registryUrl, admin, which), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${which}: HTTP ${response.status}`);
    return response.json();
  };

  let failure: string;
  try {
    const parsed = parseMetadata(
      admin,
      input.pinned.id,
      await read('info'),
      await read('instruments'),
    );
    if (parsed.ok) {
      const warnings = differences(held, parsed.metadata).map(
        (d) => `the registry disagrees with what was held: ${d}`,
      );
      if (parsed.metadata.paused) warnings.push(`${parsed.metadata.id} is paused at its registry`);
      return {
        metadata: parsed.metadata,
        source: 'registry',
        fetchedAt: input.now.toISOString(),
        warnings,
      };
    }
    failure = parsed.reason;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (input.lastKnownGood !== undefined) {
    return {
      ...input.lastKnownGood,
      source: 'last-known-good',
      warnings: [
        `the registry could not be read (${failure}); using the value read at ${String(input.lastKnownGood.fetchedAt)}`,
      ],
    };
  }
  return {
    metadata: fromPinned(input.pinned),
    source: 'pinned',
    fetchedAt: null,
    warnings: [
      `the registry could not be read (${failure}); using the capture of ${input.pinned.capturedUtc} (${input.pinned.source})`,
    ],
  };
}

/** Is a registry answer still inside the refresh window? */
export function isFresh(resolved: Resolved, now: Date, refreshAfterMs = REFRESH_AFTER_MS): boolean {
  if (resolved.source !== 'registry' || resolved.fetchedAt === null) return false;
  return now.getTime() - Date.parse(resolved.fetchedAt) < refreshAfterMs;
}

/**
 * The standard's transfer-instruction endpoints, under this registrar's prefix
 * (`splice-api-token-transfer-instruction-v1` OpenAPI:
 * `/registry/transfer-instruction/v1/transfer-factory` and
 * `/registry/transfer-instruction/v1/{id}/choice-contexts/{accept|reject|withdraw}`).
 */
export function transferInstructionUrl(registryUrl: string, admin: string, path: string): string {
  return metadataUrl(registryUrl, admin, 'info').replace(
    /\/metadata\/v1\/info$/,
    `/transfer-instruction/v1/${path}`,
  );
}

/** What the registry returns for a factory or choice-context request. */
export interface RegistryContext {
  readonly factoryId?: string;
  readonly transferKind?: string;
  readonly choiceContextData: unknown;
  readonly disclosedContracts: unknown[];
}

async function post(
  fetchImpl: Fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`registry ${url.split('/registry/')[1]} -> HTTP ${r.status}`);
  return r.json();
}

/** Ask the registry for the factory and context of a transfer. */
export async function transferFactory(
  fetchImpl: Fetch,
  registryUrl: string,
  admin: string,
  choiceArguments: unknown,
  timeoutMs = REGISTRY_TIMEOUT_MS,
): Promise<RegistryContext> {
  const r = (await post(
    fetchImpl,
    transferInstructionUrl(registryUrl, admin, 'transfer-factory'),
    { choiceArguments },
    timeoutMs,
  )) as {
    factoryId?: unknown;
    transferKind?: unknown;
    choiceContext?: { choiceContextData?: unknown; disclosedContracts?: unknown };
  };
  if (typeof r.factoryId !== 'string' || !r.choiceContext)
    throw new Error('registry returned no factoryId or choiceContext');
  return {
    factoryId: r.factoryId,
    ...(typeof r.transferKind === 'string' ? { transferKind: r.transferKind } : {}),
    choiceContextData: r.choiceContext.choiceContextData,
    disclosedContracts: Array.isArray(r.choiceContext.disclosedContracts)
      ? r.choiceContext.disclosedContracts
      : [],
  };
}

/** Ask the registry for the context of accepting, rejecting or withdrawing an instruction. */
export async function choiceContext(
  fetchImpl: Fetch,
  registryUrl: string,
  admin: string,
  instructionId: string,
  which: 'accept' | 'reject' | 'withdraw',
  timeoutMs = REGISTRY_TIMEOUT_MS,
): Promise<RegistryContext> {
  const r = (await post(
    fetchImpl,
    transferInstructionUrl(
      registryUrl,
      admin,
      `${encodeURIComponent(instructionId)}/choice-contexts/${which}`,
    ),
    {},
    timeoutMs,
  )) as {
    choiceContextData?: unknown;
    disclosedContracts?: unknown;
  };
  return {
    choiceContextData: r.choiceContextData,
    disclosedContracts: Array.isArray(r.disclosedContracts) ? r.disclosedContracts : [],
  };
}
