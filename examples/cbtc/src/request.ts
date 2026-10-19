/**
 * Build a CBTC payment request, and read one back, against what the registry
 * says CBTC is.
 *
 * `@payvol/core` is instrument-agnostic and stays that way: it does not know
 * that CBTC has ten decimals or which party is its registrar. Those two checks
 * live here, read from the registry at run time:
 *
 *  - **Decimals.** Core accepts any number of fractional digits. A CBTC amount
 *    with more than the registry's `decimals` cannot be represented by the
 *    instrument. Building one is REFUSED, and reading one back WARNS. Neither
 *    rounds, because a rounded amount is a different request.
 *  - **Registrar.** An instrument named `CBTC` under some other admin is not
 *    CBTC, and a CBTC admin from another network is not this network's: the
 *    three networks' identities are never mixed.
 *
 * Only profile `0.1`, the shipped one, is built. A `0.2-draft` request needs a
 * settlement `destination` (a CIP-0112 Account), and what its `provider` and
 * `id` mean on CBTC's registry is not established. It is left out rather than
 * guessed.
 */
import { encode, decode, sha256, toCanonical, validate, type TransferPayvol } from '@payvol/core';
import { linkPayload, qrPayload } from '@payvol/qr';
import { splitInstrument } from './instrument.js';
import { networkOfAdmin, type Network } from './network.js';
import type { InstrumentMetadata } from './registry.js';

/** How many fractional digits an amount string carries. Strings only, never a float. */
export function fractionalDigits(amount: string): number {
  const dot = amount.indexOf('.');
  return dot === -1 ? 0 : amount.length - dot - 1;
}

/** Does this amount fit the instrument's decimals? */
export function scaleFinding(amount: string, decimals: number): string | null {
  const digits = fractionalDigits(amount);
  return digits > decimals
    ? `amount ${amount} has ${digits} fractional digits; the registry gives this instrument ${decimals}`
    : null;
}

/** What a request is built from. */
export interface RequestInput {
  readonly recipient: string;
  readonly amount: string;
  readonly reference?: string;
  readonly expiry: string;
  readonly label?: string;
}

/** A built request, in every form a payer can be handed. */
export interface BuiltRequest {
  readonly request: TransferPayvol;
  /** The `canton:` URI. */
  readonly uri: string;
  /** The same bytes as a `web+canton:` link. */
  readonly link: string;
  /** What a QR symbol should carry. */
  readonly qr: string;
  /** SHA-256 of the request's canonical JSON (JCS), as `@payvol/core` derives it. */
  readonly digest: string;
  /** `validate()`'s warnings, carried rather than dropped. */
  readonly warnings: readonly string[];
}

/**
 * Build a request for CBTC.
 *
 * @throws with the reason, when the amount exceeds the instrument's decimals or
 * the request does not validate. A request this refuses to build is one no
 * wallet should be handed.
 */
export function buildRequest(
  input: RequestInput,
  instrument: InstrumentMetadata,
  options: { now?: Date } = {},
): BuiltRequest {
  const scale = scaleFinding(input.amount, instrument.decimals);
  if (scale !== null) throw new Error(`AMOUNT_BEYOND_DECIMALS: ${scale}`);

  const request: TransferPayvol = {
    version: '0.1',
    type: 'transfer',
    recipient: input.recipient,
    instrument: `${instrument.admin}/${instrument.id}`,
    amount: input.amount,
    expiry: input.expiry,
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    ...(input.label === undefined ? {} : { label: input.label }),
  };
  const checked = validate(request, options.now === undefined ? {} : { now: options.now });
  if (!checked.valid) throw new Error(`${checked.code}: ${checked.message}`);

  return {
    request: checked.payvol as TransferPayvol,
    uri: encode(checked.payvol),
    /* `web+canton:`, the form a browser can register a handler for; the
       default would repeat the URI above. */
    link: linkPayload(checked.payvol, { scheme: 'web+canton' }),
    qr: qrPayload(checked.payvol),
    digest: sha256(toCanonical(checked.payvol)),
    warnings: (checked.warnings ?? []).map((w) => `${w.code}: ${w.message}`),
  };
}

/** What reading a request back establishes, as a payer's wallet would need it. */
export interface Verdict {
  readonly valid: boolean;
  /** Set when `valid` is false: a reason code and its sentence. */
  readonly refusal?: string;
  readonly request?: TransferPayvol;
  /** Things a payer should see before signing; none of them stops the read. */
  readonly warnings: readonly string[];
}

/**
 * Read a `canton:` URI (or `web+canton:` link) back, and check it against CBTC
 * on `network`.
 */
export function verifyRequest(
  uri: string,
  network: Network,
  instrument: InstrumentMetadata,
  options: { now?: Date } = {},
): Verdict {
  let decoded;
  try {
    decoded = decode(uri);
  } catch (error) {
    return {
      valid: false,
      refusal: String(error instanceof Error ? error.message : error),
      warnings: [],
    };
  }
  const checked = validate(decoded, options.now === undefined ? {} : { now: options.now });
  if (!checked.valid)
    return { valid: false, refusal: `${checked.code}: ${checked.message}`, warnings: [] };
  const request = checked.payvol;
  if (request.type !== 'transfer') {
    return {
      valid: false,
      refusal: 'NOT_A_TRANSFER: this example reads transfer requests only',
      warnings: [],
    };
  }

  const warnings = (checked.warnings ?? []).map((w) => `${w.code}: ${w.message}`);
  const parts = splitInstrument(request.instrument);
  const elsewhere = parts === undefined ? undefined : networkOfAdmin(parts.admin);

  if (parts !== undefined && elsewhere !== undefined && elsewhere !== network) {
    return {
      valid: false,
      refusal: `NOT_THIS_NETWORK: the instrument admin is CBTC's ${elsewhere} registrar, and this is ${network}`,
      request,
      warnings,
    };
  }
  if (parts === undefined || parts.admin !== instrument.admin || parts.id !== instrument.id) {
    warnings.push(
      parts !== undefined && parts.id === instrument.id
        ? `ADMIN_NOT_CBTC_REGISTRAR: ${parts.id} under ${parts.admin}, which is not CBTC's ${network} registrar (${instrument.admin})`
        : `NOT_CBTC: the instrument is ${request.instrument}, not ${instrument.admin}/${instrument.id}`,
    );
  }
  if (request.amount !== undefined) {
    const scale = scaleFinding(request.amount, instrument.decimals);
    if (scale !== null) warnings.push(`AMOUNT_BEYOND_DECIMALS: ${scale}`);
  }
  if (instrument.paused)
    warnings.push(`INSTRUMENT_PAUSED: ${instrument.id} is paused at its registry`);
  return { valid: true, request, warnings };
}
