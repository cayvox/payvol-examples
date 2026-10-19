/**
 * Pay and observe, offline, against SYNTHETIC fixtures.
 *
 * The fixtures under `examples/cbtc/fixtures/synthetic/` are built only from the
 * public Token Standard interfaces (CIP-0056, `splice-api-token-*` in
 * canton-network/splice at `fcdadce`) with placeholder parties and invented
 * template ids. They are not captures, and nothing in them is copied from any
 * ledger.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@payvol/core';
import type { TransferPayvol } from '@payvol/core';
import { Ledger } from './ledger.js';
import { observePayment, parseTrust, trustFromUpdates } from './observe.js';
import {
  choiceContext,
  transferFactory,
  transferInstructionUrl,
  type Fetch,
  type InstrumentMetadata,
} from './registry.js';
import {
  decimalAtLeast,
  executeBefore,
  INTERFACES,
  META_KEYS,
  payableRequest,
  requestDigest,
  review,
  selectHoldings,
  transferChoiceArgs,
  type HoldingView,
} from './transfer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures', 'synthetic');
const load = (f: string) =>
  JSON.parse(readFileSync(join(FIX, f), 'utf8')) as Record<string, unknown>;
const REQ = load('request.json') as { request: TransferPayvol; digest: string };
const update = (f: string) => load(f)['update'];

const SYNTH: InstrumentMetadata = {
  admin: 'registrar::1220aabbcc',
  id: 'SYNTH',
  symbol: 'SYNTH',
  decimals: 10,
  paused: false,
};
const NOW = new Date('2026-10-18T00:00:00Z');
const h = (contractId: string, amount: string, over: Partial<HoldingView> = {}): HoldingView => ({
  contractId,
  owner: 'payer::1220aabbcc',
  instrumentId: { admin: SYNTH.admin, id: SYNTH.id },
  amount,
  locked: false,
  ...over,
});

describe('choosing what to spend', () => {
  it('compares decimals exactly, as strings', () => {
    expect(decimalAtLeast('0.1', '0.0999999999')).toBe(true);
    expect(decimalAtLeast('0.0999999999', '0.1')).toBe(false);
    expect(decimalAtLeast('12345678901234567890.1', '12345678901234567890.1')).toBe(true);
  });

  it('covers the amount with unlocked holdings of this instrument and owner, largest first', () => {
    const r = selectHoldings(
      [
        h('small', '0.004'),
        h('big', '0.009'),
        h('locked', '1', { locked: true }),
        h('other', '1', { instrumentId: { admin: 'x::1220aabbcc', id: 'SYNTH' } }),
        h('theirs', '1', { owner: 'payee::1220aabbcc' }),
      ],
      { admin: SYNTH.admin, id: SYNTH.id },
      'payer::1220aabbcc',
      '0.01',
    );
    expect(r).toEqual({ ok: true, contractIds: ['big', 'small'], total: '0.013' });
  });

  it('refuses when unlocked holdings do not cover it, and says why', () => {
    const r = selectHoldings(
      [h('a', '0.005'), h('b', '1', { locked: true })],
      SYNTH,
      'payer::1220aabbcc',
      '0.01',
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/total 0.005, less than 0.01.*locked/);
  });
});

describe('which requests can be paid', () => {
  /* Full-length parties, built at run time: validate() warns on a placeholder
     party, and a request no ledger can resolve is not payable. */
  const PAYEE = `payee::1220${'b'.repeat(64)}`;
  const ADMIN = `registrar::1220${'a'.repeat(64)}`;
  const FULL: InstrumentMetadata = { ...SYNTH, admin: ADMIN };
  const full = { ...REQ.request, recipient: PAYEE, instrument: `${ADMIN}/SYNTH` } as TransferPayvol;
  const uri = (over: Partial<TransferPayvol> = {}) =>
    encode({ ...full, ...over } as TransferPayvol);

  it('pays a complete request for this instrument', () => {
    expect(payableRequest(uri(), FULL, NOW)).toMatchObject({ ok: true });
  });

  it('refuses a request whose parties are placeholders, in validate()’s words', () => {
    const r = payableRequest(encode(REQ.request), SYNTH, NOW);
    expect(r.ok === false && r.reason).toMatch(/is not a Canton party id/);
  });

  it('refuses another instrument, no amount, too many decimals, a paused instrument', () => {
    expect(
      payableRequest(uri({ instrument: `other::1220${'c'.repeat(64)}/SYNTH` }), FULL, NOW).ok,
    ).toBe(false);
    const { amount: _a, ...noAmount } = full;
    void _a;
    expect(payableRequest(encode(noAmount as TransferPayvol), FULL, NOW)).toMatchObject({
      ok: false,
      reason: 'the request states no amount',
    });
    expect(payableRequest(uri({ amount: '0.00000000001' }), FULL, NOW).ok).toBe(false);
    expect(payableRequest(uri(), { ...FULL, paused: true }, NOW).ok).toBe(false);
  });
});

describe('what is submitted, and what the payer sees first', () => {
  const plan = {
    request: REQ.request,
    sender: 'payer::1220aabbcc',
    inputs: ['00syn-payer-holding'],
    requestedAt: '2026-10-18T00:00:00Z',
    executeBefore: '2026-10-19T00:00:00Z',
  };

  it('builds TransferFactory_Transfer arguments in the standard shape, with the Payvol metadata keys', () => {
    const args = transferChoiceArgs(plan);
    expect(Object.keys(args).sort()).toEqual(['expectedAdmin', 'extraArgs', 'transfer']);
    const t = args['transfer'] as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual([
      'amount',
      'executeBefore',
      'inputHoldingCids',
      'instrumentId',
      'meta',
      'receiver',
      'requestedAt',
      'sender',
    ]);
    expect((t['meta'] as { values: Record<string, string> }).values).toEqual({
      [META_KEYS.reason]: 'INV-SYNTH-0002',
      [META_KEYS.digest]: REQ.digest,
      [META_KEYS.profile]: '0.1',
    });
    expect(requestDigest(REQ.request)).toBe(REQ.digest);
    expect(args['extraArgs']).toEqual({ context: { values: {} }, meta: { values: {} } });
  });

  it('never sets a deadline later than the request expiry', () => {
    expect(executeBefore(REQ.request, new Date('2026-12-31T12:00:00Z'))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(executeBefore(REQ.request, NOW)).toBe('2026-10-19T00:00:00.000Z');
  });

  it('shows the full parties, the registrar, the amount and the metadata', () => {
    const text = review(transferChoiceArgs(plan), 'devnet');
    for (const s of [
      '0.0100000000 SYNTH',
      'registrar::1220aabbcc',
      'payer::1220aabbcc',
      'payee::1220aabbcc',
      'payvol.xyz/request-digest=' + REQ.digest,
    ]) {
      expect(text).toContain(s);
    }
  });
});

describe('the registry and the ledger are asked in the standard shapes', () => {
  it('puts the transfer-instruction endpoints under the registrar prefix', () => {
    expect(
      transferInstructionUrl(
        'https://registry.example',
        'registrar::1220' + 'a'.repeat(64),
        'transfer-factory',
      ),
    ).toBe(
      'https://registry.example/api/token-standard/v0/registrars/registrar::1220' +
        'a'.repeat(64) +
        '/registry/transfer-instruction/v1/transfer-factory',
    );
  });

  it('posts the factory request and the choice-context request, and refuses a failure', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body ?? 'null') });
      return url.includes('transfer-factory')
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              factoryId: 'f',
              transferKind: 'offer',
              choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [] },
            }),
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({ choiceContextData: { values: {} }, disclosedContracts: [] }),
          };
    };
    const admin = 'registrar::1220' + 'a'.repeat(64);
    await expect(
      transferFactory(fake, 'https://registry.example', admin, { x: 1 }),
    ).resolves.toMatchObject({ factoryId: 'f', transferKind: 'offer' });
    await choiceContext(fake, 'https://registry.example', admin, '00abc', 'accept');
    expect(seen[0]!.body).toEqual({ choiceArguments: { x: 1 } });
    expect(seen[1]!.url.endsWith('/transfer-instruction/v1/00abc/choice-contexts/accept')).toBe(
      true,
    );
    const failing: Fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
    await expect(transferFactory(failing, 'https://registry.example', admin, {})).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('reads with eventFormat and the two public interface views, never the legacy filter', () => {
    const f = Ledger.filterFor('p::1220aabbcc') as Record<
      string,
      { cumulative: { identifierFilter: Record<string, { value: Record<string, unknown> }> }[] }
    >;
    const views = f['p::1220aabbcc']!.cumulative.flatMap((c) =>
      c.identifierFilter['InterfaceFilter'] ? [c.identifierFilter['InterfaceFilter'].value] : [],
    );
    expect(views.map((v) => v['interfaceId']).sort()).toEqual(
      [INTERFACES.holding, INTERFACES.transferInstruction].sort(),
    );
    expect(views.every((v) => v['includeInterfaceView'] === true)).toBe(true);
    const source = readFileSync(join(HERE, 'ledger.ts'), 'utf8');
    expect(source).not.toMatch(/\bfilter:\s*\{/);
    expect(source).toContain('eventFormat');
  });
});

describe('the payee derives its own trust policy, and observes with it', () => {
  const derived = trustFromUpdates(update('offer-update.json'), update('accept-update.json'));

  it('derives a policy from an offer and its acceptance, by the public interface names', () => {
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.trust.offerTemplates).toEqual([
      {
        packageId: 'synthetic-registry-package',
        module: 'Synthetic.Registry',
        entity: 'Instruction',
      },
    ]);
    expect(derived.trust.completedResultTag).toBe('TransferInstructionResult_Completed');
    expect(parseTrust(JSON.parse(JSON.stringify(derived.trust)))).toMatchObject({ ok: true });
  });

  it('refuses a policy file with a missing piece', () => {
    expect(parseTrust({}).ok).toBe(false);
    expect(parseTrust({ ...(derived.ok ? derived.trust : {}), completedResultTag: '' }).ok).toBe(
      false,
    );
  });

  const observe = (resolving?: string, request = REQ.request) =>
    observePayment({
      request,
      offerUpdate: update('offer-update.json'),
      ...(resolving ? { resolvingUpdate: update(resolving) } : {}),
      trust: derived.ok ? derived.trust : (undefined as never),
      observedAt: '2026-10-18T00:00:01Z',
    });

  it('an accepted offer settles, and matches its request on every axis', () => {
    const o = observe('accept-update.json');
    expect(o.outcome).toMatchObject({ lifecycle: 'settled' });
    expect(o.checks).toEqual({
      digestMatchesRequest: true,
      receiverMatchesRequest: true,
      instrumentMatchesRequest: true,
      creditedAtLeastRequested: true,
    });
  });

  it('a rejected or withdrawn offer is that, and never a payment', () => {
    expect(observe('reject-update.json').outcome).toMatchObject({ lifecycle: 'rejected' });
    expect(observe('withdraw-update.json').outcome).toMatchObject({ lifecycle: 'withdrawn' });
    expect(observe('reject-update.json').checks.creditedAtLeastRequested).toBeNull();
  });

  it('an offer alone is an offer', () => {
    const o = observe();
    expect(o.offer).toMatchObject({ lifecycle: 'offered' });
    expect(o.outcome).toBeNull();
  });

  it('a payment for a different request does not match it', () => {
    expect(
      observe('accept-update.json', { ...REQ.request, reference: 'INV-OTHER' }).checks
        .digestMatchesRequest,
    ).toBe(false);
  });
});

describe('the synthetic fixtures are synthetic', () => {
  const text = readdirSync(FIX)
    .map((f) => readFileSync(join(FIX, f), 'utf8'))
    .join('\n');

  it('carry no full-length party fingerprint, only placeholders', () => {
    expect(text).not.toMatch(/::1220[0-9a-f]{64}/);
  });

  it('name only synthetic templates and the public interfaces', () => {
    const templateIds = [...text.matchAll(/"templateId": "([^"]+)"/g)].map((m) => m[1]!);
    expect(templateIds.length).toBeGreaterThan(0);
    expect(
      templateIds.every((t) => t.startsWith('synthetic-registry-package:Synthetic.Registry:')),
    ).toBe(true);
    const interfaceIds = [...text.matchAll(/"interfaceId": "([^"]+)"/g)].map((m) => m[1]!);
    expect(
      interfaceIds.every((i) =>
        /:Splice\.Api\.Token\.(HoldingV1:Holding|TransferInstructionV1:TransferInstruction)$/.test(
          i,
        ),
      ),
    ).toBe(true);
  });
});
