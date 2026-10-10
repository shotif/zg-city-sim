/// <reference lib="webworker" />
/**
 * Orders the routing graph for the engine's contraction hierarchy (M11c) in a worker of its
 * own: nested dissection takes seconds, which the simulation's worker spends stepping
 * (with A* routes) meanwhile.
 */
import { TrafficEngine } from './wasm';

declare const self: DedicatedWorkerGlobalScope;

export interface OrderRequest {
  wasmUrl: string;
  graph: Uint32Array;
}

export type OrderReply = { order: Uint32Array; ms: number } | { error: string };

self.addEventListener('message', (event: MessageEvent<OrderRequest>) => {
  void order(event.data).then(
    (reply) => self.postMessage(reply, 'order' in reply ? [reply.order.buffer] : []),
    (e: unknown) => self.postMessage({ error: e instanceof Error ? e.message : String(e) }),
  );
});

async function order({ wasmUrl, graph }: OrderRequest): Promise<OrderReply> {
  const t0 = performance.now();
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not load the traffic engine (HTTP ${response.status})`);
  const engine = await TrafficEngine.create(await response.arrayBuffer());
  const order = engine.order(graph);
  if (order.length === 0) throw new Error('Not a routing graph');
  return { order, ms: performance.now() - t0 };
}
