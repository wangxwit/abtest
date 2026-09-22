import { getTopology, type Topology } from './traffic.ts';
import { getParameterService } from './service-catalog.ts';

/** replaceState does not emit hashchange; route consumers listen to this as well. */
export const APPLICATION_ROUTE_CHANGE_EVENT = 'applicationroutechange';

export function serviceHref(id: string, tab?: string): string {
  return `#applications/services/${encodeURIComponent(id)}${tab ? `/${encodeURIComponent(tab)}` : ''}`;
}

/** Ownership is resolved from configuration, never inferred from parameter prefixes. */
export function parameterHref(key: string, topology: Topology = getTopology()): string {
  const service = getParameterService(key, topology);
  return service ? `${serviceHref(service.id, 'parameters')}/${encodeURIComponent(key)}` : `#applications/unassigned/${encodeURIComponent(key)}`;
}

function decoded(value: string | undefined): string {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Pure when supplied a topology; canonicalization never changes catalog or allocations. */
export function canonicalApplicationRoute(hash: string, topology: Topology = getTopology()): string {
  const parts = hash.split('/');
  if (parts[0] === '#parameters' || (parts[0] === '#applications' && parts[1] === 'parameters')) {
    const key = decoded(parts[parts[0] === '#parameters' ? 1 : 2]);
    return key ? parameterHref(key, topology) : '#applications';
  }
  if (parts[0] === '#applications' && parts[1] === 'unassigned') {
    const key = decoded(parts[2]);
    return key ? parameterHref(key, topology) : '#applications';
  }
  const legacyService = parts[0] === '#services';
  if (legacyService || (parts[0] === '#applications' && parts[1] === 'services')) {
    const offset = legacyService ? 1 : 2;
    const id = decoded(parts[offset]), tab = decoded(parts[offset + 1]);
    if (!id) return '#applications';
    if (tab === 'parameters') {
      const key = decoded(parts[offset + 2]);
      return key ? parameterHref(key, topology) : serviceHref(id, tab);
    }
    return legacyService ? `${serviceHref(id)}${parts.slice(offset + 1).length ? `/${parts.slice(offset + 1).join('/')}` : ''}` : hash;
  }
  return hash;
}
