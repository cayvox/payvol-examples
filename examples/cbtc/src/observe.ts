/**
 * Observe a CBTC payment on the payee's own participant, with the trust policy
 * the payee derived from its own ledger.
 *
 * THIS EXAMPLE SHIPS NO POLICY. A `TransferTrustPolicy` names the registry's
 * own templates and package ids. Those are a property of the network and the
 * registry's current release, they change with upgrades, and `@payvol/core`
 * ships no default and refuses to guess them. So the payee supplies one:
 *
 *  - `trustFromUpdates()` derives it from one offer update and its acceptance,
 *    read on the payee's own participant. It matches events by the PUBLIC
 *    Token Standard interface names only (`Splice.Api.Token.*`), and records
 *    whatever concrete template and package ids that ledger reports.
 *  - `parseTrust()` checks a policy file field by field before use.
 *
 * Then `observePayment()` runs `recordFromUpdate` → `resolveOffer` and checks
 * the settlement against the request: digest, amount, receiver, instrument.
 */
import {
  recordFromUpdate,
  resolveOffer,
  type ObservationRecord,
  type TemplateId,
  type TransferTrustPolicy,
} from '@payvol/core/draft02';
import type { TransferPayvol } from '@payvol/core';
import { splitInstrument } from './instrument.js';
import { decimalAtLeast, META_KEYS, requestDigest } from './transfer.js';

const TI_SUFFIX = ':Splice.Api.Token.TransferInstructionV1:TransferInstruction';
const HOLDING_SUFFIX = ':Splice.Api.Token.HoldingV1:Holding';

/** The standard's choice names on `TransferInstruction` (TransferInstructionV1.daml). */
const CHOICES = {
  accept: ['TransferInstruction_Accept'],
  reject: ['TransferInstruction_Reject'],
  withdraw: ['TransferInstruction_Withdraw'],
};

type Raw = { update?: { Transaction?: { value?: { events?: Record<string, unknown>[] } } } };
const events = (raw: unknown): Record<string, Record<string, unknown>>[] =>
  ((raw as Raw)?.update?.Transaction?.value?.events ?? []) as Record<
    string,
    Record<string, unknown>
  >[];

function templateIdOf(value: unknown): TemplateId | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(':');
  if (parts.length !== 3 || parts.some((p) => p === '')) return undefined;
  return { packageId: parts[0]!, module: parts[1]!, entity: parts[2]! };
}

/**
 * Derive a trust policy from one offer update and the update that accepted it,
 * both read on your own participant with interface views included.
 */
export function trustFromUpdates(
  offerUpdate: unknown,
  acceptUpdate: unknown,
): { ok: true; trust: TransferTrustPolicy } | { ok: false; reason: string } {
  const offer = events(offerUpdate)
    .map((e) => e['CreatedEvent'])
    .find((c) =>
      ((c?.['interfaceViews'] as { interfaceId?: string }[] | undefined) ?? []).some((v) =>
        String(v.interfaceId).endsWith(TI_SUFFIX),
      ),
    );
  if (offer === undefined) {
    return {
      ok: false,
      reason: 'the offer update creates no contract with a TransferInstruction view',
    };
  }
  const accept = events(acceptUpdate)
    .map((e) => e['ExercisedEvent'])
    .find(
      (x) => x?.['choice'] === CHOICES.accept[0] && String(x?.['interfaceId']).endsWith(TI_SUFFIX),
    );
  if (accept === undefined) {
    return {
      ok: false,
      reason: 'the accept update has no TransferInstruction_Accept through the standard interface',
    };
  }
  const holding = events(acceptUpdate)
    .map((e) => e['CreatedEvent'])
    .flatMap((c) => (c?.['interfaceViews'] as { interfaceId?: string }[] | undefined) ?? [])
    .find((v) => String(v.interfaceId).endsWith(HOLDING_SUFFIX));
  const tag = (accept['exerciseResult'] as { output?: { tag?: unknown } } | undefined)?.output?.tag;
  const offerTemplate = templateIdOf(offer['templateId']);
  const offerInterface = templateIdOf(accept['interfaceId']);
  const holdingInterface = templateIdOf(holding?.interfaceId);
  if (!offerTemplate || !offerInterface || !holdingInterface || typeof tag !== 'string') {
    return {
      ok: false,
      reason:
        'the updates lack a template id, interface id, Holding view or result tag; read them with interface views included',
    };
  }
  return {
    ok: true,
    trust: {
      offerTemplates: [offerTemplate],
      offerInterfaces: [offerInterface],
      choices: CHOICES,
      completedResultTag: tag,
      holdingInterfaces: [holdingInterface],
    },
  };
}

/** Check a policy file before trusting anything with it. */
export function parseTrust(
  json: unknown,
): { ok: true; trust: TransferTrustPolicy } | { ok: false; reason: string } {
  const t = json as Partial<Record<keyof TransferTrustPolicy, unknown>>;
  const ids = (v: unknown): v is TemplateId[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) =>
      ['packageId', 'module', 'entity'].every(
        (k) =>
          typeof (x as Record<string, unknown>)?.[k] === 'string' &&
          (x as Record<string, string>)[k] !== '',
      ),
    );
  const names = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
  const c = t.choices as Record<string, unknown> | undefined;
  if (!ids(t.offerTemplates))
    return {
      ok: false,
      reason: 'offerTemplates must be a non-empty list of {packageId, module, entity}',
    };
  if (!ids(t.offerInterfaces))
    return {
      ok: false,
      reason: 'offerInterfaces must be a non-empty list of {packageId, module, entity}',
    };
  if (!ids(t.holdingInterfaces))
    return {
      ok: false,
      reason: 'holdingInterfaces must be a non-empty list of {packageId, module, entity}',
    };
  if (!c || !names(c['accept']) || !names(c['reject']) || !names(c['withdraw']))
    return { ok: false, reason: 'choices must name accept, reject and withdraw' };
  if (typeof t.completedResultTag !== 'string' || t.completedResultTag === '')
    return { ok: false, reason: 'completedResultTag must be a non-empty string' };
  return { ok: true, trust: json as TransferTrustPolicy };
}

/** What observing one payment established. */
export interface PaymentObservation {
  readonly offer: ObservationRecord | { missing: string[] };
  readonly outcome: ObservationRecord | { missing: string[] } | null;
  readonly checks: {
    readonly digestMatchesRequest: boolean;
    readonly receiverMatchesRequest: boolean;
    readonly instrumentMatchesRequest: boolean;
    readonly creditedAtLeastRequested: boolean | null;
  };
}

/**
 * Read an offer and, if given, the update that resolved it, and check what
 * settled against the request it was meant to pay.
 */
export function observePayment(input: {
  request: TransferPayvol;
  offerUpdate: unknown;
  resolvingUpdate?: unknown;
  trust: TransferTrustPolicy;
  observedAt: string;
}): PaymentObservation {
  const keys = { digest: META_KEYS.digest, profile: META_KEYS.profile };
  const offer = recordFromUpdate(input.offerUpdate, {
    observationId: 'offer',
    observedAt: input.observedAt,
    metadataKeys: keys,
    trust: input.trust,
  });
  const outcome =
    offer.ok && input.resolvingUpdate !== undefined
      ? resolveOffer(offer.record, input.resolvingUpdate, {
          observationId: 'outcome',
          observedAt: input.observedAt,
          metadataKeys: keys,
          trust: input.trust,
        })
      : null;
  const rec = offer.ok ? offer.record : undefined;
  const parts = splitInstrument(input.request.instrument);
  const settled =
    outcome?.ok && outcome.record.lifecycle === 'settled' ? outcome.record : undefined;
  return {
    offer: offer.ok ? offer.record : { missing: offer.missing },
    outcome: outcome === null ? null : outcome.ok ? outcome.record : { missing: outcome.missing },
    checks: {
      digestMatchesRequest: rec?.digest === requestDigest(input.request),
      receiverMatchesRequest: rec?.receiver === input.request.recipient,
      instrumentMatchesRequest:
        parts !== undefined &&
        rec?.instrument.admin === parts.admin &&
        rec?.instrument.id === parts.id,
      creditedAtLeastRequested:
        settled === undefined || input.request.amount === undefined
          ? null
          : decimalAtLeast(settled.amount, input.request.amount),
    },
  };
}
