/**
 * Split a v0.1 `admin/id` instrument string into the Token Standard pair.
 *
 * The split is at the FIRST `/`: the admin is a party id, which carries no `/`,
 * and everything after the first separator is the id. Returns `undefined` when
 * there is no `/` at all. An empty admin or id is returned as such, for the
 * caller to judge.
 */

/** An instrument's registry admin party and its id within that registry. */
export interface InstrumentParts {
  readonly admin: string;
  readonly id: string;
}

// Same as @payvol/core's splitInstrument, which ships after 0.4.0; switch to it once published.
export function splitInstrument(instrument: string): InstrumentParts | undefined {
  const slash = instrument.indexOf('/');
  if (slash === -1) return undefined;
  return { admin: instrument.slice(0, slash), id: instrument.slice(slash + 1) };
}
