/** Reader for packed typed arrays written by pipeline/packed.py. */

const CONSTRUCTORS = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
} as const;

export type PackedType = keyof typeof CONSTRUCTORS;
export type TypedArray = InstanceType<(typeof CONSTRUCTORS)[PackedType]>;

export interface PackedIndex {
  file: string;
  byteLength: number;
  arrays: Record<string, { type: PackedType; offset: number; length: number }>;
}

const isGzip = (buffer: ArrayBuffer) => {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return head[0] === 0x1f && head[1] === 0x8b;
};

/** Typed-array views over one packed blob. */
export function unpack(buffer: ArrayBuffer, index: PackedIndex): Record<string, TypedArray> {
  if (buffer.byteLength !== index.byteLength) {
    throw new Error(`packed data is ${buffer.byteLength} bytes, expected ${index.byteLength}`);
  }
  const out: Record<string, TypedArray> = {};
  for (const [name, spec] of Object.entries(index.arrays)) {
    out[name] = new CONSTRUCTORS[spec.type](buffer, spec.offset, spec.length);
  }
  return out;
}

/** Fetch a packed blob (gzip-compressed or already decoded by the server) and unpack it. */
export async function loadPacked(
  url: string,
  index: PackedIndex,
): Promise<Record<string, TypedArray>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  let buffer = await response.arrayBuffer();
  if (isGzip(buffer)) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    buffer = await new Response(stream).arrayBuffer();
  }
  return unpack(buffer, index);
}
