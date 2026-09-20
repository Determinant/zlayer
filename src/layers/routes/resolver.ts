import type { AirwayDataResponse, NavigationData, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { createRouteResolver } from '@zlayer/domain';

type Resolver = ReturnType<typeof createRouteResolver>;
const recent: Array<{ inputs: readonly unknown[]; resolve: Resolver }> = [];

/** Reuse national indexes across edits and recommendation models. Resource
 * identity, including collection order, preserves the resolver's exact semantics. */
export function routeResolver(data: NavigationData, airways?: AirwayDataResponse,
  terminal?: TerminalProceduresData, preferred?: PreferredRoutesData): Resolver {
  const collections = Object.values(data);
  const inputs = [airways, terminal, preferred, ...collections];
  const index = recent.findIndex(entry => entry.inputs.length === inputs.length &&
    entry.inputs.every((value, position) => value === inputs[position]));
  const entry = index >= 0 ? recent.splice(index, 1)[0]!
    : { inputs, resolve: createRouteResolver(collections, airways, terminal, preferred) };
  recent.push(entry);
  if (recent.length > 4) recent.shift();
  return entry.resolve;
}
