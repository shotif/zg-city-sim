/** Hand-built road networks for the tests. */
import { type RoadNetworkIndex, RoadNetwork } from '../src/world/roadNetwork';

const NONE = 0xffffffff;

/**
 * Ilica runs east (two lanes) into a signalled junction at x = 100 and on east (one
 * lane); Savska cesta leaves it north. The right lane goes straight on, the left lane
 * turns left.
 */
export function junction(): RoadNetwork {
  const index = {
    file: '',
    byteLength: 0,
    arrays: {},
    vclassBits: { passenger: 1, bus: 2 },
    flags: { bridge: 1, tunnel: 2, hasOpposite: 4, roundabout: 8, internal: 16 },
    types: ['highway.primary'],
    junctionTypes: [],
    names: ['Ilica', 'Savska cesta'],
    tlsTypes: [],
    linkDirs: ['s', 'l', 'r', 't', 'L', 'R', 'invalid'],
    linkStates: [],
    none: NONE,
  } as RoadNetworkIndex;
  // Lane shapes in centimetres: origin per lane, then steps from it.
  const lanes: [number, number, number, number][] = [
    [500, 160, 9000, 0], // Ilica in, right lane
    [500, -160, 9000, 0], // Ilica in, left lane
    [10500, 160, 9000, 0], // Ilica on
    [10160, -500, 0, -9000], // Savska cesta north
  ];
  return new RoadNetwork(index, {
    junctionPos: new Float32Array([0, 0, 100, 0, 200, 0, 100, -100]),
    junctionType: new Uint8Array(4),
    junctionShapeOffsets: new Uint32Array([0, 0, 0, 0, 0]),
    junctionShapeOrigin: new Int32Array(0),
    junctionShapeDelta: new Int16Array(0),
    junctionShapeElev: new Int16Array(0),
    edgeFrom: new Uint32Array([0, 1, 1]),
    edgeTo: new Uint32Array([1, 2, 3]),
    edgeType: new Uint16Array(3),
    edgeFlags: new Uint8Array(3),
    edgeName: new Uint32Array([0, 0, 1]),
    edgeLaneStart: new Uint32Array([0, 2, 3]),
    edgeLaneCount: new Uint8Array([2, 1, 1]),
    laneEdge: new Uint32Array([0, 0, 1, 2]),
    laneLength: new Float32Array([90, 90, 90, 90]),
    laneSpeed: new Float32Array([13.9, 13.9, 13.9, 13.9]),
    laneWidth: new Float32Array([3.2, 3.2, 3.2, 3.2]),
    laneAllow: new Uint16Array([1, 1, 1, 1]),
    laneLinkOffsets: new Uint32Array([0, 1, 2, 2, 2]),
    laneShapeOffsets: new Uint32Array([0, 2, 4, 6, 8]),
    laneShapeOrigin: new Int32Array(lanes.flatMap(([x, z]) => [x, z])),
    laneShapeDelta: new Int16Array(lanes.flatMap(([, , dx, dz]) => [0, 0, dx, dz])),
    laneShapeElev: new Int16Array(8),
    linkFrom: new Uint32Array([0, 1]),
    linkTo: new Uint32Array([2, 3]),
    linkDir: new Uint8Array([0, 1]),
    linkJunction: new Uint32Array([1, 1]),
    linkTls: new Uint32Array([0, 0]),
  });
}

const LANE_WIDTH = 3.2;
const STATES = ['M', 'm', '=', 's', 'w', 'Z', 'O', 'o', 'G', 'g', 'y', 'r', 'u'];
const DIRS = ['s', 'l', 'r', 't', 'L', 'R', 'invalid'];

/**
 * Hand-built networks as the pipeline exports them: lanes grouped by edge (rightmost
 * first), roads stopping 6 m short of junction centres, one internal lane per link, links
 * sorted by the lane they leave.
 */
export class NetMaker {
  junctions: [number, number][] = [];
  edges: {
    from: number;
    to: number;
    type: number;
    flags: number;
    name: number;
    lanes: number[];
  }[] = [];
  lanes: { edge: number; shape: number[]; speed: number; allow: number; next: number }[] = [];
  links: { from: number; to: number; via: number; junction: number; dir: number; state: number }[] =
    [];
  logic = new Map<number, [number, number][]>();
  /** Signal programs: links (as made) and phases (seconds, states). */
  signals: { links: number[]; phases: [number, string][] }[] = [];
  names: string[] = [];
  types = ['internal', 'highway.primary', 'highway.residential'];

  junction(x: number, z: number): number {
    this.junctions.push([x, z]);
    return this.junctions.length - 1;
  }

  /** Straight one-way road from junction a to b, `lanes` lanes, named. */
  road(a: number, b: number, lanes: number, name = '', type = 1): number {
    const [ax, az] = this.junctions[a];
    const [bx, bz] = this.junctions[b];
    const len = Math.hypot(bx - ax, bz - az);
    const [ux, uz] = [(bx - ax) / len, (bz - az) / len];
    // Right of travel (x east, z south): (-uz, ux).
    const [rx, rz] = [-uz, ux];
    const e = this.edges.length;
    let n = this.names.indexOf(name);
    if (name && n < 0) n = this.names.push(name) - 1;
    this.edges.push({ from: a, to: b, type, flags: 0, name: name ? n : NONE, lanes: [] });
    for (let k = 0; k < lanes; k++) {
      const off = (lanes - k - 0.5) * LANE_WIDTH;
      const shape = [
        ax + ux * 6 + rx * off,
        az + uz * 6 + rz * off,
        0,
        bx - ux * 6 + rx * off,
        bz - uz * 6 + rz * off,
        0,
      ];
      this.edges[e].lanes.push(this.lanes.length);
      this.lanes.push({ edge: e, shape, speed: 13.9, allow: 1 | 2 | 8, next: NONE });
    }
    return e;
  }

  lane(edge: number, k: number): number {
    return this.edges[edge].lanes[k];
  }

  connect(from: number, to: number, j: number, dir: string, state = 'M'): number {
    const f = this.lanes[from].shape;
    const t = this.lanes[to].shape;
    const e = this.edges.length;
    this.edges.push({ from: j, to: j, type: 0, flags: 16, name: NONE, lanes: [this.lanes.length] });
    this.lanes.push({
      edge: e,
      shape: [f[f.length - 3], f[f.length - 2], 0, t[0], t[1], 0],
      speed: 13.9,
      allow: 1 | 2 | 8,
      next: to,
    });
    this.links.push({
      from,
      to,
      via: this.lanes.length - 1,
      junction: j,
      dir: DIRS.indexOf(dir),
      state: STATES.indexOf(state),
    });
    return this.links.length - 1;
  }

  private signalOf(link: NetMaker['links'][number]): { tls: number; index: number } {
    const made = this.links.indexOf(link);
    for (const [t, s] of this.signals.entries()) {
      const i = s.links.indexOf(made);
      if (i >= 0) return { tls: t, index: i };
    }
    return { tls: NONE, index: 0xffff };
  }

  network(): RoadNetwork {
    const index = {
      file: '',
      byteLength: 0,
      arrays: {},
      vclassBits: { passenger: 1, bus: 2, tram: 4, truck: 8 },
      flags: { bridge: 1, tunnel: 2, hasOpposite: 4, roundabout: 8, internal: 16 },
      types: this.types,
      junctionTypes: [
        'priority',
        'right_before_left',
        'traffic_light',
        'rail_crossing',
        'dead_end',
      ],
      names: this.names,
      tlsTypes: ['actuated'],
      linkDirs: DIRS,
      linkStates: STATES,
      none: NONE,
    } as RoadNetworkIndex;
    const order = this.links
      .map((_, i) => i)
      .sort((a, b) => this.links[a].from - this.links[b].from);
    const links = order.map((i) => this.links[i]);
    const requests = new Map<number, number>();
    const linkRequest = links.map((l) => {
      const r = requests.get(l.junction) ?? 0;
      requests.set(l.junction, r + 1);
      return r;
    });
    // Logic: rows given per junction in the order links were made there.
    const made = new Map<number, number[]>();
    this.links.forEach((l, i) => made.set(l.junction, [...(made.get(l.junction) ?? []), i]));
    const logic: number[] = [];
    const linkCount: number[] = [];
    const logicOffset: number[] = [];
    for (let j = 0; j < this.junctions.length; j++) {
      const at = links.map((l, k) => [l, k] as const).filter(([l]) => l.junction === j);
      linkCount.push(at.length);
      logicOffset.push(logic.length);
      const rows = this.logic.get(j) ?? [];
      const byMade = made.get(j) ?? [];
      for (const [l] of at) {
        const k = byMade.indexOf(this.links.indexOf(l));
        logic.push(...(rows[k] ?? [0, 0]));
      }
    }
    const laneLinkOffsets = new Uint32Array(this.lanes.length + 1);
    for (const l of links) laneLinkOffsets[l.from + 1]++;
    for (let i = 0; i < this.lanes.length; i++) laneLinkOffsets[i + 1] += laneLinkOffsets[i];
    const shapeOffsets = new Uint32Array(this.lanes.length + 1);
    this.lanes.forEach((l, i) => (shapeOffsets[i + 1] = shapeOffsets[i] + l.shape.length / 3));
    const lane = Float32Array.from(this.lanes.flatMap((l) => l.shape));
    const length = this.lanes.map((l) =>
      Math.hypot(l.shape[3] - l.shape[0], l.shape[4] - l.shape[1]),
    );
    const arrays = {
      junctionPos: Float32Array.from(this.junctions.flat()),
      junctionType: new Uint8Array(this.junctions.length),
      junctionShapeOffsets: new Uint32Array(this.junctions.length + 1),
      junctionLinkCount: Uint16Array.from(linkCount),
      junctionLogicOffset: Uint32Array.from(logicOffset),
      logic: Uint32Array.from(logic),
      edgeFrom: Uint32Array.from(this.edges.map((e) => e.from)),
      edgeTo: Uint32Array.from(this.edges.map((e) => e.to)),
      edgeType: Uint16Array.from(this.edges.map((e) => e.type)),
      edgeFlags: Uint8Array.from(this.edges.map((e) => e.flags)),
      edgeName: Uint32Array.from(this.edges.map((e) => e.name)),
      edgeRef: new Uint32Array(this.edges.length).fill(NONE),
      edgeLaneStart: Uint32Array.from(this.edges.map((e) => e.lanes[0])),
      edgeLaneCount: Uint8Array.from(this.edges.map((e) => e.lanes.length)),
      laneEdge: Uint32Array.from(this.lanes.map((l) => l.edge)),
      laneLength: Float32Array.from(length),
      laneSpeed: Float32Array.from(this.lanes.map((l) => l.speed)),
      laneWidth: new Float32Array(this.lanes.length).fill(LANE_WIDTH),
      laneAllow: Uint16Array.from(this.lanes.map((l) => l.allow)),
      laneNext: Uint32Array.from(this.lanes.map((l) => l.next)),
      laneLinkOffsets,
      laneShapeOffsets: shapeOffsets,
      linkFrom: Uint32Array.from(links.map((l) => l.from)),
      linkTo: Uint32Array.from(links.map((l) => l.to)),
      linkVia: Uint32Array.from(links.map((l) => l.via)),
      linkJunction: Uint32Array.from(links.map((l) => l.junction)),
      linkRequest: Uint16Array.from(linkRequest),
      linkDir: Uint8Array.from(links.map((l) => l.dir)),
      linkState: Uint8Array.from(links.map((l) => l.state)),
      linkTls: Uint32Array.from(links.map((l) => this.signalOf(l).tls)),
      linkTlsIndex: Uint16Array.from(links.map((l) => this.signalOf(l).index)),
      tlsPhaseOffsets: Uint32Array.from(
        this.signals.reduce((o, s) => [...o, o[o.length - 1] + s.phases.length], [0]),
      ),
      tlsOffset: new Float32Array(this.signals.length),
      tlsType: new Uint8Array(this.signals.length),
      phaseDuration: Float32Array.from(this.signals.flatMap((s) => s.phases.map((p) => p[0]))),
      phaseMinDur: Float32Array.from(this.signals.flatMap((s) => s.phases.map((p) => p[0]))),
      phaseMaxDur: Float32Array.from(this.signals.flatMap((s) => s.phases.map((p) => p[0]))),
      phaseStateOffsets: Uint32Array.from(
        this.signals
          .flatMap((s) => s.phases.map((p) => p[1].length))
          .reduce((o, n) => [...o, o[o.length - 1] + n], [0]),
      ),
      phaseStates: Uint8Array.from(
        this.signals.flatMap((s) => s.phases.flatMap((p) => [...p[1]].map((c) => c.charCodeAt(0)))),
      ),
    };
    return new RoadNetwork(index, arrays, { lane, junction: new Float32Array(0) });
  }
}
