/**
 * The kinds of services (M20a): primary schools, kindergartens, health care, fire and
 * police stations, and a service as the pipeline writes it (pipeline/services.py).
 */

export type ServiceKind = 'school' | 'kindergarten' | 'health' | 'fire' | 'police';

/** A service as the pipeline writes it (`services/services.json`). */
export interface Service {
  kind: ServiceKind;
  name: string;
  x: number;
  z: number;
  /** The street in front (today's network). */
  edge: number;
  /** Index into the City's districts; -1 outside the City. */
  district: number;
  /** Pupils, children or registered patients it takes (an estimate); 0 for fire and police. */
  places: number;
}

export interface ServicesData {
  kinds: ServiceKind[];
  districts: string[];
  services: Service[];
}

/** Each kind's name, what its places are, and its marker's letter. */
export const SERVICE_KINDS: Record<
  ServiceKind,
  { label: string; one: string; places?: string; letter: string }
> = {
  school: { label: 'Primary schools', one: 'Primary school', places: 'pupils', letter: 'Š' },
  kindergarten: { label: 'Kindergartens', one: 'Kindergarten', places: 'children', letter: 'V' },
  health: {
    label: 'GP practices and health centres',
    one: 'GP practice or health centre',
    places: 'patients registered',
    letter: 'Z',
  },
  fire: { label: 'Fire stations', one: 'Fire station', letter: 'F' },
  police: { label: 'Police stations', one: 'Police station', letter: 'P' },
};
