/**
 * The offline half of the CBTC example, against the registry's own answers.
 *
 * NO NETWORK. Every registry response below is a committed capture from
 * `fixtures/registry/`, replayed through an injected `fetch`. The capture is
 * what a test can hold still; the live registry is what
 * `npm run refresh-metadata` asks.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decode, sha256, toCanonical } from '@payvol/core';
import { splitInstrument } from './instrument.js';
import { CAPTURE_DIR, EXAMPLE_DIR, NETWORKS, networkOfAdmin, parseNetwork, pinned } from './network.js';
import {
  differences,
  fromPinned,
  isFresh,
  metadataUrl,
  parseMetadata,
  resolveInstrument,
  type Fetch,
} from './registry.js';
import { buildRequest, fractionalDigits, scaleFinding, verifyRequest } from './request.js';

const capture = (file: string): unknown =>
  JSON.parse(readFileSync(join(EXAMPLE_DIR, CAPTURE_DIR, file), 'utf8')) as unknown;
const provenance = capture('provenance.json') as {
  captures: { file: string; url: string; capturedUtc: string; httpStatus: number; sha256: string }[];
};

/** A `fetch` that answers from the capture, and records what it was asked. */
function replay(
  network: string,
  override: Partial<Record<'info' | 'instruments', unknown>> = {},
): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    const which = url.endsWith('/info') ? 'info' : 'instruments';
    const body = which in override ? override[which] : capture(`${network}-${which}.json`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, asked };
}

const failing: Fetch = async () => {
  throw new Error('getaddrinfo ENOTFOUND');
};

const NOW = new Date('2026-10-18T12:00:00Z');
const RECIPIENT = `payvol-demo-recipient::1220${'ab'.repeat(32)}`;

describe('the capture is the bytes the registry returned', () => {
  const dir = join(EXAMPLE_DIR, CAPTURE_DIR);
  const expected = NETWORKS.flatMap((n) => [`${n}-info.json`, `${n}-instruments.json`]);

  it('holds the six metadata responses and their provenance, and nothing else', () => {
    expect(readdirSync(dir).sort()).toEqual([...expected, 'provenance.json'].sort());
    expect(provenance.captures.map((c) => c.file).sort()).toEqual([...expected].sort());
  });

  it.each(expected)('%s hashes to the SHA-256 its provenance records', (file) => {
    const entry = provenance.captures.find((c) => c.file === file);
    expect(entry?.httpStatus).toBe(200);
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const actual = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
    expect(actual, `${file} was modified after capture`).toBe(entry?.sha256);
  });
});

describe('splitting an instrument string', () => {
  it('splits at the first slash, and refuses a string with none', () => {
    expect(splitInstrument('cbtc-network::1220ab/CBTC')).toEqual({
      admin: 'cbtc-network::1220ab',
      id: 'CBTC',
    });
    expect(splitInstrument('a/b/c')).toEqual({ admin: 'a', id: 'b/c' });
    expect(splitInstrument('/CBTC')).toEqual({ admin: '', id: 'CBTC' });
    expect(splitInstrument('CBTC')).toBeUndefined();
  });
});

describe('the pinned identities are read from the capture, never typed', () => {
  it.each(NETWORKS)('%s: admin, id and decimals equal the registry response', (network) => {
    const p = pinned(network);
    const info = capture(`${network}-info.json`) as { adminId: string };
    const body = capture(`${network}-instruments.json`) as {
      instruments: { id: string; symbol: string; decimals: number }[];
    };
    expect(p.admin).toBe(info.adminId);
    expect(p.admin).toMatch(/^cbtc-network::1220[0-9a-f]{64}$/);
    expect(p.id).toBe('CBTC');
    expect(p.symbol).toBe(body.instruments[0]?.symbol);
    expect(p.decimals).toBe(body.instruments[0]?.decimals);
  });

  it('the three networks have three different admins and registries', () => {
    const all = NETWORKS.map(pinned);
    expect(new Set(all.map((p) => p.admin)).size).toBe(3);
    expect(new Set(all.map((p) => p.registryUrl)).size).toBe(3);
  });

  it('the URL this example asks is the URL that was captured', () => {
    for (const network of NETWORKS) {
      const p = pinned(network);
      for (const which of ['info', 'instruments'] as const) {
        const captured = provenance.captures.find((c) => c.file === `${network}-${which}.json`);
        expect(metadataUrl(p.registryUrl, p.admin, which)).toBe(captured?.url);
      }
    }
  });

  it('NETWORK is one of three, and nothing else', () => {
    expect(parseNetwork('testnet')).toBe('testnet');
    expect(() => parseNetwork('TestNet')).toThrow(/NETWORK must be one of/);
    expect(() => parseNetwork(undefined)).toThrow();
  });
});

describe('the registry answer is checked before it is used', () => {
  const p = pinned('testnet');

  it('refuses an admin that could redirect the request', () => {
    expect(() => metadataUrl(p.registryUrl, 'x/../../other', 'info')).toThrow(/full party/);
    expect(() => metadataUrl('http://plain.example', p.admin, 'info')).toThrow(/https origin/);
  });

  it('refuses /info that names another admin', () => {
    const r = parseMetadata(
      p.admin,
      'CBTC',
      { adminId: pinned('mainnet').admin },
      capture('testnet-instruments.json'),
    );
    expect(r).toEqual({ ok: false, reason: `/info does not name ${p.admin} as its admin` });
  });

  it('refuses decimals that are not a non-negative integer', () => {
    const r = parseMetadata(p.admin, 'CBTC', capture('testnet-info.json'), {
      instruments: [{ id: 'CBTC', symbol: 'CBTC', decimals: 10.5, paused: false }],
      nextPageToken: null,
    });
    expect(r.ok).toBe(false);
  });

  it('says so when the instrument may be on a page it does not follow', () => {
    const r = parseMetadata(p.admin, 'CBTC', capture('testnet-info.json'), {
      instruments: [],
      nextPageToken: 'abc',
    });
    expect(r.ok === false && r.reason).toMatch(/following pages is not implemented/);
  });
});

describe('resolving the instrument: registry first, then what was last known', () => {
  const p = pinned('testnet');

  it('reads both endpoints and returns what the registry says', async () => {
    const { fetch, asked } = replay('testnet');
    const r = await resolveInstrument({ pinned: p, fetch, now: NOW });
    expect(r.source).toBe('registry');
    expect(r.metadata).toEqual({
      admin: p.admin,
      id: 'CBTC',
      symbol: 'CBTC',
      decimals: 10,
      paused: false,
    });
    expect(r.warnings).toEqual([]);
    expect(asked.map((u) => u.split('/').pop())).toEqual(['info', 'instruments']);
  });

  it('warns on every field that changed, and still uses the new answer', async () => {
    const { fetch } = replay('testnet', {
      instruments: {
        instruments: [{ id: 'CBTC', symbol: 'CBTC', decimals: 8, paused: true }],
        nextPageToken: null,
      },
    });
    const r = await resolveInstrument({ pinned: p, fetch, now: NOW });
    expect(r.metadata.decimals).toBe(8);
    expect(r.warnings).toEqual([
      'the registry disagrees with what was held: decimals changed: 10 -> 8',
      'the registry disagrees with what was held: paused changed: false -> true',
      'CBTC is paused at its registry',
    ]);
  });

  it('keeps the last known good value when the registry cannot be read', async () => {
    const good = await resolveInstrument({ pinned: p, fetch: replay('testnet').fetch, now: NOW });
    const r = await resolveInstrument({ pinned: p, fetch: failing, now: NOW, lastKnownGood: good });
    expect(r.source).toBe('last-known-good');
    expect(r.metadata).toEqual(good.metadata);
    expect(r.warnings[0]).toMatch(/could not be read \(getaddrinfo ENOTFOUND\)/);
  });

  it('falls back to the pinned capture, and says which, when nothing better is known', async () => {
    const r = await resolveInstrument({ pinned: p, fetch: failing, now: NOW });
    expect(r.source).toBe('pinned');
    expect(r.metadata).toEqual(fromPinned(p));
    expect(r.warnings[0]).toContain(p.source);
  });

  it('treats an HTTP error as a failed read, not as an answer', async () => {
    const http500: Fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const r = await resolveInstrument({ pinned: p, fetch: http500, now: NOW });
    expect(r.source).toBe('pinned');
    expect(r.warnings[0]).toMatch(/HTTP 500/);
  });

  it('a registry answer is fresh for ten minutes, and a fallback never is', async () => {
    const r = await resolveInstrument({ pinned: p, fetch: replay('testnet').fetch, now: NOW });
    expect(isFresh(r, new Date(NOW.getTime() + 9 * 60_000))).toBe(true);
    expect(isFresh(r, new Date(NOW.getTime() + 11 * 60_000))).toBe(false);
    const fallback = await resolveInstrument({ pinned: p, fetch: failing, now: NOW });
    expect(isFresh(fallback, NOW)).toBe(false);
  });

  it('differences() names nothing when nothing changed', () => {
    expect(differences(fromPinned(p), fromPinned(p))).toEqual([]);
  });
});

describe('building a CBTC request', () => {
  const cbtc = fromPinned(pinned('testnet'));
  const input = {
    recipient: RECIPIENT,
    amount: '0.0013567821',
    expiry: '2027-01-01T00:00:00Z',
    reference: 'INV-CBTC-0001',
  };

  it('round-trips through the URI, with the digest core derives', () => {
    const built = buildRequest(input, cbtc, { now: NOW });
    const back = decode(built.uri);
    expect(back).toMatchObject({ instrument: `${cbtc.admin}/CBTC`, amount: '0.0013567821' });
    expect(built.digest).toBe(sha256(toCanonical(built.request)));
    expect(built.link.startsWith('web+canton:')).toBe(true);
    expect(built.warnings).toEqual([]);
  });

  it('refuses an amount beyond the registry decimals, and does not round it', () => {
    expect(() => buildRequest({ ...input, amount: '0.00135678211' }, cbtc, { now: NOW })).toThrow(
      /AMOUNT_BEYOND_DECIMALS: amount 0.00135678211 has 11 fractional digits; the registry gives this instrument 10/,
    );
  });

  it('counts fractional digits on the string, never on a number', () => {
    expect(fractionalDigits('1')).toBe(0);
    expect(fractionalDigits('0.1000000000')).toBe(10);
    expect(scaleFinding('123456789012345678901234567890.0000000001', 10)).toBeNull();
  });
});

describe('reading a CBTC request back', () => {
  const testnet = fromPinned(pinned('testnet'));
  const uriFor = (instrument: { admin: string; id: string }, amount = '0.5') =>
    buildRequest(
      { recipient: RECIPIENT, amount, expiry: '2027-01-01T00:00:00Z' },
      { ...testnet, ...instrument, decimals: 20 },
      { now: NOW },
    ).uri;

  it('accepts this network’s CBTC with no warning', () => {
    const v = verifyRequest(uriFor(testnet), 'testnet', testnet, { now: NOW });
    expect(v).toMatchObject({ valid: true, warnings: [] });
  });

  it('refuses another network’s CBTC admin', () => {
    const v = verifyRequest(uriFor(pinned('mainnet')), 'testnet', testnet, { now: NOW });
    expect(v.valid).toBe(false);
    expect(v.refusal).toMatch(
      /^NOT_THIS_NETWORK: the instrument admin is CBTC's mainnet registrar/,
    );
    expect(networkOfAdmin(pinned('mainnet').admin)).toBe('mainnet');
  });

  it('warns on CBTC under an admin that is not a CBTC registrar', () => {
    const lookalike = { admin: `cbtc-network::1220${'0'.repeat(64)}`, id: 'CBTC' };
    const v = verifyRequest(uriFor(lookalike), 'testnet', testnet, { now: NOW });
    expect(v.valid).toBe(true);
    expect(v.warnings[0]).toMatch(/^ADMIN_NOT_CBTC_REGISTRAR: CBTC under cbtc-network::1220000/);
  });

  it('warns, and does not refuse, on an amount beyond the decimals', () => {
    const v = verifyRequest(uriFor(testnet, '0.00135678211'), 'testnet', testnet, { now: NOW });
    expect(v.valid).toBe(true);
    expect(v.warnings).toEqual([
      'AMOUNT_BEYOND_DECIMALS: amount 0.00135678211 has 11 fractional digits; the registry gives this instrument 10',
    ]);
  });

  it('refuses what core refuses, with core’s reason', () => {
    const v = verifyRequest('canton:', 'testnet', testnet, { now: NOW });
    expect(v.valid).toBe(false);
  });
});

/*
 * The guide (docs/cbtc-guide.md at the root of this repository) names every
 * network's admin and registry. Each one must be the captured value, so the
 * guide can never teach a party the registry did not return. Skipped only while
 * the guide does not exist.
 */
const GUIDE = join(EXAMPLE_DIR, '..', '..', 'docs', 'cbtc-guide.md');
describe.skipIf(!existsSync(GUIDE))('every identifier in the guide is the captured one', () => {
  const guide = existsSync(GUIDE) ? readFileSync(GUIDE, 'utf8') : '';
  const pins = NETWORKS.map(pinned);

  it('names all three admins, and no other cbtc-network party', () => {
    const named = new Set(guide.match(/cbtc-network::1220[0-9a-f]{64}/g) ?? []);
    expect([...named].sort()).toEqual(pins.map((p) => p.admin).sort());
    expect(guide.match(/cbtc-network::[0-9a-f]{1,67}(?![0-9a-f])/g) ?? []).toEqual([]);
  });

  it('names all three registries, and no other utilities host', () => {
    const named = new Set(guide.match(/https:\/\/api\.utilities\.[a-z.-]+\.com/g) ?? []);
    expect([...named].sort()).toEqual(pins.map((p) => p.registryUrl).sort());
  });

  it('puts each admin on the row of its own registry', () => {
    for (const p of pins) {
      const row = guide.split('\n').find((l) => l.includes(p.admin) && l.startsWith('|'));
      expect(row, `${p.network} row`).toContain(p.registryUrl);
    }
  });
});
