/**
 * The JSON Ledger API, as this example uses it. Every request body here uses
 * `eventFormat` / `updateFormat`; none sends the top-level `filter` / `verbose`
 * that Canton 3.6.1 rejects (BitSafe, "Compatibility and release notes":
 * https://docs.bitsafe.finance/cbtc/concepts-and-reference/compatibility-and-release-notes.md).
 * Contract data is read through the standard's interface views, so nothing
 * here depends on a registry's own templates.
 *
 * Auth: if `LEDGER_TOKEN_FILE` is set, its contents are sent as a bearer token.
 * The token is read from the file and never printed or written anywhere.
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INTERFACES, type HoldingView } from './transfer.js';

export interface LedgerConfig {
  readonly baseUrl: string;
  readonly userId: string;
  readonly tokenFile?: string;
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class Ledger {
  constructor(private readonly config: LedgerConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.tokenFile) {
      h['authorization'] = `Bearer ${readFileSync(this.config.tokenFile, 'utf8').trim()}`;
    }
    return h;
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = this.config.baseUrl.replace(/\/$/, '') + path;
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      throw new Error(`could not reach the JSON Ledger API at ${url}`, { cause });
    }
    const text = await r.text();
    let json: unknown = text;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      /* keep the text */
    }
    if (!r.ok) throw new LedgerError(`${method} ${path} -> HTTP ${r.status}`, r.status, json);
    return json;
  }

  /** The cumulative filter every read uses: everything, plus the two standard views. */
  static filterFor(party: string): Record<string, unknown> {
    const view = (interfaceId: string) => ({
      identifierFilter: {
        InterfaceFilter: {
          value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false },
        },
      },
    });
    return {
      [party]: {
        cumulative: [
          { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
          view(INTERFACES.holding),
          view(INTERFACES.transferInstruction),
        ],
      },
    };
  }

  async activeContracts(party: string): Promise<Record<string, unknown>[]> {
    const end = (await this.call('GET', '/v2/state/ledger-end')) as { offset: number };
    const rows = (await this.call('POST', '/v2/state/active-contracts', {
      eventFormat: { filtersByParty: Ledger.filterFor(party), verbose: true },
      activeAtOffset: end.offset,
    })) as { contractEntry?: { JsActiveContract?: { createdEvent?: Record<string, unknown> } } }[];
    return rows
      .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
      .filter((e): e is Record<string, unknown> => e !== undefined);
  }

  /** Holdings as their Holding interface views state them. */
  async holdings(party: string): Promise<HoldingView[]> {
    return (await this.activeContracts(party)).flatMap((e) => {
      const view = (
        e['interfaceViews'] as
          | { interfaceId?: string; viewValue?: Record<string, unknown> }[]
          | undefined
      )?.find((v) =>
        String(v.interfaceId).endsWith(':Splice.Api.Token.HoldingV1:Holding'),
      )?.viewValue;
      if (!view) return [];
      return [
        {
          contractId: String(e['contractId']),
          owner: String(view['owner']),
          instrumentId: view['instrumentId'] as { admin: string; id: string },
          amount: String(view['amount']),
          locked: view['lock'] !== null && view['lock'] !== undefined,
        },
      ];
    });
  }

  /** Open transfer instructions, as their TransferInstruction views state them. */
  async instructions(
    party: string,
  ): Promise<{ contractId: string; transfer: Record<string, unknown> }[]> {
    return (await this.activeContracts(party)).flatMap((e) => {
      const view = (
        e['interfaceViews'] as
          | { interfaceId?: string; viewValue?: Record<string, unknown> }[]
          | undefined
      )?.find((v) =>
        String(v.interfaceId).endsWith(
          ':Splice.Api.Token.TransferInstructionV1:TransferInstruction',
        ),
      )?.viewValue;
      return view
        ? [
            {
              contractId: String(e['contractId']),
              transfer: view['transfer'] as Record<string, unknown>,
            },
          ]
        : [];
    });
  }

  /** One update, as `party` sees it, in the ledger-effects shape Observe reads. */
  async updateById(updateId: string, party: string): Promise<unknown> {
    return this.call('POST', '/v2/updates/update-by-id', {
      updateId,
      updateFormat: {
        includeTransactions: {
          eventFormat: { filtersByParty: Ledger.filterFor(party), verbose: true },
          transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
        },
      },
    });
  }

  private async synchronizerId(party: string): Promise<string> {
    const s = (await this.call(
      'GET',
      `/v2/state/connected-synchronizers?party=${encodeURIComponent(party)}`,
    )) as {
      connectedSynchronizers: { synchronizerId: string }[];
    };
    const first = s.connectedSynchronizers[0];
    if (!first) throw new Error(`${party} is connected to no synchronizer`);
    return first.synchronizerId;
  }

  /**
   * Submit as an EXTERNAL party: prepare, sign the prepared hash locally with
   * the party's Ed25519 key, execute and wait. The key never leaves this process.
   */
  async submitExternal(
    party: string,
    keyFile: string,
    command: unknown,
    disclosed: unknown[],
  ): Promise<{ updateId: string; raw: unknown }> {
    const prepared = (await this.call('POST', '/v2/interactive-submission/prepare', {
      userId: this.config.userId,
      commandId: `payvol-${randomUUID()}`,
      actAs: [party],
      readAs: [party],
      synchronizerId: await this.synchronizerId(party),
      commands: [command],
      disclosedContracts: disclosed,
      packageIdSelectionPreference: [],
      prefetchContractKeys: [],
      verboseHashing: false,
    })) as {
      preparedTransaction: string;
      preparedTransactionHash: string;
      hashingSchemeVersion: unknown;
    };
    const signature = sign(
      null,
      Buffer.from(prepared.preparedTransactionHash, 'base64'),
      createPrivateKey(readFileSync(keyFile)),
    );
    const raw = (await this.call(
      'POST',
      '/v2/interactive-submission/executeAndWaitForTransaction',
      {
        userId: this.config.userId,
        preparedTransaction: prepared.preparedTransaction,
        hashingSchemeVersion: prepared.hashingSchemeVersion,
        submissionId: `payvol-${randomUUID()}`,
        deduplicationPeriod: { Empty: {} },
        partySignatures: {
          signatures: [
            {
              party,
              signatures: [
                {
                  format: 'SIGNATURE_FORMAT_RAW',
                  signature: signature.toString('base64'),
                  signedBy: party.slice(party.indexOf('::') + 2),
                  signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
                },
              ],
            },
          ],
        },
      },
    )) as { transaction?: { updateId?: string } };
    return { updateId: String(raw.transaction?.updateId ?? ''), raw };
  }

  /** Submit as a party hosted on this participant, through the user's own rights. */
  async submitLocal(
    party: string,
    command: unknown,
    disclosed: unknown[],
  ): Promise<{ updateId: string; raw: unknown }> {
    const raw = (await this.call('POST', '/v2/commands/submit-and-wait-for-transaction', {
      commands: {
        commands: [command],
        commandId: `payvol-${randomUUID()}`,
        actAs: [party],
        userId: this.config.userId,
        disclosedContracts: disclosed,
      },
      transactionFormat: {
        eventFormat: { filtersByParty: Ledger.filterFor(party), verbose: true },
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    })) as { transaction?: { updateId?: string } };
    return { updateId: String(raw.transaction?.updateId ?? ''), raw };
  }
}

/** A registry's disclosed contracts, as the Ledger API's `disclosedContracts` wants them. */
export function disclosedFrom(list: unknown): unknown[] {
  return ((list as Record<string, unknown>[] | undefined) ?? []).map((d) => ({
    templateId: d['templateId'],
    contractId: d['contractId'],
    createdEventBlob: d['createdEventBlob'],
    synchronizerId: d['synchronizerId'],
  }));
}
