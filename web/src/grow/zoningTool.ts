/**
 * The Zones tool (M5a, M5b), wired to the map: painting lots with a brush while the pointer
 * is dragged, buildings growing on them as simulated time passes, the layers that draw
 * them, and keeping and sharing the zoning and what grew.
 */
import type * as THREE from 'three/webgpu';

import { ZonesPanel } from '../ui/zonesPanel';
import { GrowthLayer } from '../world/growthLayer';
import type { HeightFn } from '../world/roadGeometry';
import { ZoneLayer } from '../world/zoneLayer';
import { type EdgeDemand, addedDemand } from './demand';
import { Growth, restoreBuildings, saveBuildings } from './growth';
import type { Lots } from './lots';
import {
  type Brush,
  type SavedBuilding,
  type Stroke,
  applyStroke,
  decodeZoningFromUrl,
  encodeZoningForUrl,
  loadSavedGrowth,
  loadSavedZoning,
  saveGrowth,
  saveZoning,
  zoneTotals,
  zonesFrom,
} from './zones';

export interface ZoningDeps {
  lots: Lots;
  scene: THREE.Scene;
  hud: HTMLElement;
  canvas: HTMLCanvasElement;
  surface: HeightFn;
  terrain: THREE.BufferGeometry;
  /** The ground point under a screen point (CSS pixels in the canvas). */
  groundAt(x: number, y: number): { x: number; z: number } | undefined;
  /** Stop or restart the map's own dragging while a stroke is painted. */
  setMapDragging(on: boolean): void;
  invalidate(): void;
  /** Open or close the tool as its HUD button does. */
  open(): void;
  onClose(): void;
  /** The edge a lot's trips use (-1: none); the lot's own street if not given. */
  edgeOf?(lot: number): number;
  /** What the finished buildings add to the city's homes and jobs, per edge. */
  onDemand?(added: EdgeDemand): void;
}

export interface ZoningTool {
  lots: Lots;
  panel: ZonesPanel;
  layer: ZoneLayer;
  growth: Growth;
  grown: GrowthLayer;
  setVisible(on: boolean): void;
  /** Simulated time passed (s): buildings start and are finished. */
  tick(now: number): void;
  /** Zone codes of every lot. */
  readonly zones: Uint8Array;
  readonly strokes: readonly Stroke[];
  /** Paint a stroke as the pointer would (scene points). */
  paint(brush: Brush, radius: number, points: [number, number][]): void;
}

/** A stroke takes a new point once the pointer moved this share of the brush radius. */
const POINT_SPACING = 0.3;
/** Simulated seconds between updates of the traffic's homes and jobs, at most. */
const DEMAND_EVERY = 300;

export function setUpZoning(deps: ZoningDeps): ZoningTool {
  const { lots } = deps;
  let strokes: Stroke[] = [];
  let zones: Uint8Array = new Uint8Array(lots.count);
  const layer = new ZoneLayer(lots, deps.surface, deps.terrain);
  deps.scene.add(layer.object);
  const growth = new Growth(lots);
  const grown = new GrowthLayer(lots, deps.surface, growth.buildings);
  deps.scene.add(grown.object);
  layer.setBuilt(growth.lotBuilding);
  /** Simulated time (s) last seen. */
  let now = 0;

  const show = () => {
    panel.setTotals(zoneTotals(lots, zones), strokes.length);
    panel.setGrowth(growth.totals(now));
    deps.invalidate();
  };
  const keepGrowth = () => saveGrowth(saveBuildings(lots, growth));
  // The traffic's homes and jobs: sent when buildings were finished or taken down.
  let changes = 0;
  let sent = { key: '', at: -Infinity };
  const sendDemand = (force = false) => {
    if (!deps.onDemand) return;
    const key = `${growth.totals(now).built}:${changes}`;
    if (key === sent.key || (!force && now - sent.at < DEMAND_EVERY)) return;
    sent = { key, at: now };
    deps.onDemand(addedDemand(lots, growth, now, deps.edgeOf));
  };
  /** Buildings on lots zoned for something else come down. */
  const settle = () => {
    const gone = growth.sync(zones);
    for (const id of gone) grown.remove(id);
    if (gone.length) {
      layer.setZones(zones);
      keepGrowth();
      changes++;
      sendDemand(true);
    }
  };
  /** Keep and draw a new list of strokes (and, loading, the buildings grown on it). */
  const use = (list: Stroke[], buildings?: readonly SavedBuilding[]) => {
    strokes = list;
    zones = zonesFrom(lots, strokes);
    if (buildings) {
      growth.clear();
      restoreBuildings(lots, growth, zones, buildings);
      grown.reset();
      keepGrowth();
      changes++;
      sendDemand(true);
    } else settle();
    layer.setZones(zones);
    saveZoning(strokes);
    show();
  };

  const panel = new ZonesPanel(deps.hud, lots.planClasses, {
    onBrush: (brush) => {
      if (!brush) layer.setBrush(undefined, 0);
      deps.invalidate();
    },
    onRadius: () => deps.invalidate(),
    onPlan: (on) => {
      layer.setPlanVisible(on);
      deps.invalidate();
    },
    onUndo: () => use(strokes.slice(0, -1)),
    onClear: () => use([]),
    shareLink: async () =>
      `${location.origin}${location.pathname}${location.search}#zoning=${await encodeZoningForUrl(strokes, saveBuildings(lots, growth))}`,
    onClose: () => deps.onClose(),
  });

  // Painting: a drag with a brush chosen paints; the map is not dragged meanwhile.
  let stroke: Stroke | undefined;
  const canvas = deps.canvas;
  const at = (event: PointerEvent) => deps.groundAt(event.offsetX, event.offsetY);
  const extend = (p: { x: number; z: number }) => {
    if (!stroke) return;
    const last = stroke.points[stroke.points.length - 1];
    if (last && Math.hypot(p.x - last[0], p.z - last[1]) < stroke.radius * POINT_SPACING) return;
    stroke.points.push([Math.round(p.x), Math.round(p.z)]);
    // Paint as it goes: just the newest stretch.
    const changed = applyStroke(lots, zones, { ...stroke, points: stroke.points.slice(-2) });
    if (changed.length) layer.setZones(zones, changed);
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      const brush = panel.brush;
      if (!panel.visible || !brush || event.button !== 0) return;
      const p = at(event);
      if (!p) return;
      // Before the map's controls see it: this drag paints.
      event.stopImmediatePropagation();
      deps.setMapDragging(false);
      canvas.setPointerCapture(event.pointerId);
      stroke = { brush, radius: panel.radius, points: [] };
      extend(p);
      deps.invalidate();
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (event) => {
    if (!panel.visible || !panel.brush) return;
    const p = at(event);
    layer.setBrush(p, panel.radius);
    if (p && stroke) extend(p);
    deps.invalidate();
  });
  const finish = (event: PointerEvent) => {
    if (!stroke) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    deps.setMapDragging(true);
    const done = stroke;
    stroke = undefined;
    if (done.points.length) {
      strokes = [...strokes, done];
      saveZoning(strokes);
      settle();
    }
    show();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // Zoning from a shared link (at start, or pasted into this tab later), else this
  // browser's.
  const linked = () => /[#&]zoning=([^&]+)/.exec(location.hash)?.[1];
  const loadFromLink = (encoded: string) =>
    decodeZoningFromUrl(encoded)
      .then((city) => {
        use(city.strokes, city.buildings);
        deps.open();
        const n = city.strokes.length;
        panel.setStatus(`Loaded ${n} stroke${n === 1 ? '' : 's'} from the link.`);
      })
      .catch(() => panel.setStatus('The link has no zoning that could be read.'))
      .finally(() => history.replaceState(null, '', location.pathname + location.search));
  const fromLink = linked();
  if (fromLink) void loadFromLink(fromLink);
  else use(loadSavedZoning(), loadSavedGrowth());
  window.addEventListener('hashchange', () => {
    const encoded = linked();
    if (encoded) void loadFromLink(encoded);
  });

  const tool: ZoningTool = {
    lots,
    panel,
    layer,
    growth,
    grown,
    tick: (t) => {
      // Growth goes by the simulated minute.
      const sameMinute = Math.floor(t / 60) === Math.floor(now / 60);
      now = t;
      if (sameMinute) return;
      const started = growth.tick(zones, t);
      for (const id of started) grown.add(id);
      grown.setTime(t);
      if (started.length) {
        layer.setZones(
          zones,
          started.flatMap((id) => growth.buildings[id]?.lots ?? []),
        );
        keepGrowth();
      }
      panel.setGrowth(growth.totals(t));
      sendDemand();
      deps.invalidate();
    },
    setVisible: (on) => {
      panel.setVisible(on);
      layer.setShowAll(on);
      if (!on) layer.setBrush(undefined, 0);
      deps.invalidate();
    },
    get zones() {
      return zones;
    },
    get strokes() {
      return strokes;
    },
    paint: (brush, radius, points) => {
      const s: Stroke = {
        brush,
        radius,
        points: points.map(([x, z]) => [Math.round(x), Math.round(z)]),
      };
      strokes = [...strokes, s];
      const changed = applyStroke(lots, zones, s);
      layer.setZones(zones, changed);
      saveZoning(strokes);
      settle();
      show();
    },
  };
  return tool;
}
