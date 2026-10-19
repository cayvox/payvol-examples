/**
 * The pure half of paying a CBTC request: what to send, and what the payer is
 * shown before anything is signed.
 *
 * EVERY SHAPE HERE IS THE PUBLIC TOKEN STANDARD'S. `TransferFactory_Transfer`,
 * its `Transfer` argument and `ExtraArgs`, and the Holding view are defined in
 * `canton-network/splice` `token-standard/splice-api-token-*` (CIP-0056). The
 * registry's own templates never appear: a registry is reached through the
 * standard's interfaces and its public HTTP API, and nothing else.
 *
 * WHAT THE PAYER REVIEWS, AND WHAT IS TRUSTED. `review()` renders the transfer
 * command from the same object that is submitted, and `pay` submits nothing
 * until the payer has seen it and confirmed. For an external party, the
 * participant then prepares the transaction and `pay` signs the hash the
 * participant returns. This example does not decode that prepared transaction
 * or recompute its hash, so it trusts your participant to prepare exactly the
 * command shown. A wallet or production integration should verify it before
 * signing (the Payvol specification, §10, shipped as `SPEC.md` in the
 * `@payvol/core` package, requires clear-signing).
 */
import { decode, sha256, toCanonical, validate } from '@payvol/core';
import type { TransferPayvol } from '@payvol/core';
import { splitInstrument } from './instrument.js';
import type { InstrumentMetadata } from './registry.js';
import { scaleFinding } from './request.js';

/** The standard's interface ids, by package name (the Ledger API accepts these). */
export const INTERFACES = {
  holding: '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
  transferInstruction:
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction',
  transferFactory:
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
} as const;

/**
 * The metadata keys a Payvol transfer carries. The reason key is the Token
 * Standard's (CIP-0056); the other two are Payvol's own, under `payvol.xyz/`.
 */
export const META_KEYS = {
  reason: 'splice.lfdecentralizedtrust.org/reason',
  digest: 'payvol.xyz/request-digest',
  profile: 'payvol.xyz/profile',
} as const;

/** One holding as its Holding interface view states it. */
export interface HoldingView {
  readonly contractId: string;
  readonly owner: string;
  readonly instrumentId: { admin: string; id: string };
  readonly amount: string;
  readonly locked: boolean;
}

/** `a >= b` for unsigned decimal strings, exactly. */
export function decimalAtLeast(a: string, b: string): boolean {
  const scale = Math.max(fraction(a).length, fraction(b).length);
  return toInt(a, scale) >= toInt(b, scale);
}
const fraction = (s: string): string => (s.includes('.') ? s.slice(s.indexOf('.') + 1) : '');
const toInt = (s: string, scale: number): bigint =>
  BigInt(s.split('.')[0]! + fraction(s).padEnd(scale, '0'));
const add = (a: string, b: string): string => {
  const scale = Math.max(fraction(a).length, fraction(b).length);
  const sum = (toInt(a, scale) + toInt(b, scale)).toString().padStart(scale + 1, '0');
  return scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`;
};

/**
 * Pick the payer's unlocked holdings of this instrument until they cover the
 * amount, largest first. Refuses rather than sending a transfer the registry
 * would reject for want of funds.
 */
export function selectHoldings(
  views: readonly HoldingView[],
  instrument: { admin: string; id: string },
  owner: string,
  amount: string,
): { ok: true; contractIds: string[]; total: string } | { ok: false; reason: string } {
  const usable = views
    .filter(
      (v) =>
        !v.locked &&
        v.owner === owner &&
        v.instrumentId.admin === instrument.admin &&
        v.instrumentId.id === instrument.id,
    )
    .sort((x, y) => (decimalAtLeast(x.amount, y.amount) ? -1 : 1));
  const chosen: string[] = [];
  let total = '0';
  for (const v of usable) {
    if (decimalAtLeast(total, amount)) break;
    chosen.push(v.contractId);
    total = add(total, v.amount);
  }
  return decimalAtLeast(total, amount) && chosen.length > 0
    ? { ok: true, contractIds: chosen, total }
    : {
        ok: false,
        reason: `unlocked ${instrument.id} holdings total ${total}, less than ${amount}. Holdings locked in an open offer are not spendable.`,
      };
}

/** What a payment is built from: the request, and what the payer chose. */
export interface PaymentPlan {
  readonly request: TransferPayvol;
  readonly sender: string;
  readonly inputs: readonly string[];
  readonly requestedAt: string;
  readonly executeBefore: string;
}

/** Read a `canton:` URI into a payable CBTC request, or say why it is not one. */
export function payableRequest(
  uri: string,
  instrument: InstrumentMetadata,
  now: Date,
): { ok: true; request: TransferPayvol } | { ok: false; reason: string } {
  const checked = validate(decode(uri), { now });
  if (!checked.valid) return { ok: false, reason: `${checked.code}: ${checked.message}` };
  const request = checked.payvol;
  if (request.type !== 'transfer') return { ok: false, reason: 'not a transfer request' };
  if ((checked.warnings ?? []).length > 0) {
    return { ok: false, reason: checked.warnings!.map((w) => w.message).join(' ') };
  }
  const parts = splitInstrument(request.instrument);
  if (parts?.admin !== instrument.admin || parts.id !== instrument.id) {
    return {
      ok: false,
      reason: `the request asks for ${request.instrument}, not this network's CBTC`,
    };
  }
  if (request.amount === undefined || request.amount === '') {
    return { ok: false, reason: 'the request states no amount' };
  }
  const scale = scaleFinding(request.amount, instrument.decimals);
  if (scale !== null) return { ok: false, reason: scale };
  if (request.expiry === undefined) return { ok: false, reason: 'the request carries no expiry' };
  if (instrument.paused) return { ok: false, reason: `${instrument.id} is paused at its registry` };
  return { ok: true, request };
}

/** The digest a 0.1 request is identified by: SHA-256 of its canonical JSON. */
export const requestDigest = (request: TransferPayvol): string => sha256(toCanonical(request));

/**
 * `TransferFactory_Transfer`'s arguments, as the standard defines them. The
 * registry's choice context goes in `extraArgs.context` once the registry has
 * returned it; until then it is empty, which is what the transfer-factory
 * request itself carries.
 */
export function transferChoiceArgs(
  plan: PaymentPlan,
  context: unknown = { values: {} },
): Record<string, unknown> {
  const parts = splitInstrument(plan.request.instrument)!;
  return {
    expectedAdmin: parts.admin,
    transfer: {
      sender: plan.sender,
      receiver: plan.request.recipient,
      amount: plan.request.amount,
      instrumentId: { admin: parts.admin, id: parts.id },
      requestedAt: plan.requestedAt,
      executeBefore: plan.executeBefore,
      inputHoldingCids: plan.inputs,
      meta: {
        values: {
          ...(plan.request.reference === undefined
            ? {}
            : { [META_KEYS.reason]: plan.request.reference }),
          [META_KEYS.digest]: requestDigest(plan.request),
          [META_KEYS.profile]: plan.request.version ?? '0.1',
        },
      },
    },
    extraArgs: { context, meta: { values: {} } },
  };
}

/** The deadline: the request's expiry, never later. */
export function executeBefore(request: TransferPayvol, now: Date, maxHours = 24): string {
  const cap = new Date(now.getTime() + maxHours * 3600_000);
  const expiry = new Date(request.expiry!);
  return (expiry < cap ? expiry : cap).toISOString();
}

/**
 * The text a payer reads before signing, from the exact arguments that will
 * be submitted. Party ids are shown in full; nothing is abbreviated away.
 */
export function review(args: Record<string, unknown>, network: string): string {
  const t = args['transfer'] as {
    sender: string;
    receiver: string;
    amount: string;
    instrumentId: { admin: string; id: string };
    executeBefore: string;
    inputHoldingCids: string[];
    meta: { values: Record<string, string> };
  };
  return [
    `You are about to sign ONE transfer on ${network}:`,
    `  amount        ${t.amount} ${t.instrumentId.id}`,
    `  instrument    ${t.instrumentId.id}`,
    `  registrar     ${t.instrumentId.admin}`,
    `  from          ${t.sender}`,
    `  to            ${t.receiver}`,
    `  deadline      ${t.executeBefore}`,
    `  spends        ${t.inputHoldingCids.length} holding(s); change returns to you`,
    `  metadata      ${Object.entries(t.meta.values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n                ')}`,
    `Whoever can read this transfer can read that metadata.`,
  ].join('\n');
}
