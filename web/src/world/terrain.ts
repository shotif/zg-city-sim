import * as THREE from 'three/webgpu';

import { DATA_URL, type WorldManifest } from '../manifest';
import type { WorldFrame } from './frame';
import { Heightfield, decodeTerrainRgb } from './heightfield';

/** Rectangle the ground texture covers, in scene coordinates. */
export interface TextureExtent {
  west: number;
  north: number;
  width: number;
  height: number;
}

/**
 * Grid mesh over the heightfield, taking every `stride`-th sample.
 * UVs map the texture extent with v = 0 at the northern edge (use texture.flipY = false).
 */
export function buildTerrainGeometry(
  hf: Heightfield,
  stride: number,
  uvExtent: TextureExtent,
): THREE.BufferGeometry {
  const cols = Math.floor((hf.cols - 1) / stride) + 1;
  const rows = Math.floor((hf.rows - 1) / stride) + 1;
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const step = hf.resolution * stride;

  for (let r = 0; r < rows; r++) {
    const sr = r * stride;
    const z = hf.north + (sr + 0.5) * hf.resolution;
    for (let c = 0; c < cols; c++) {
      const sc = c * stride;
      const x = hf.west + (sc + 0.5) * hf.resolution;
      const i = r * cols + c;
      positions[i * 3] = x;
      positions[i * 3 + 1] = hf.at(sc, sr);
      positions[i * 3 + 2] = z;

      // Surface y = h(x, z) has normal (-dh/dx, 1, -dh/dz); central differences one step apart.
      const dhdx = (hf.at(sc + stride, sr) - hf.at(sc - stride, sr)) / (2 * step);
      const dhdz = (hf.at(sc, sr + stride) - hf.at(sc, sr - stride)) / (2 * step);
      const len = Math.hypot(dhdx, 1, dhdz);
      normals[i * 3] = -dhdx / len;
      normals[i * 3 + 1] = 1 / len;
      normals[i * 3 + 2] = -dhdz / len;

      uvs[i * 2] = (x - uvExtent.west) / uvExtent.width;
      uvs[i * 2 + 1] = (z - uvExtent.north) / uvExtent.height;
    }
  }

  // Two triangles per cell, counter-clockwise seen from above.
  const index = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c; // north-west corner
      const b = a + cols; // south-west
      const d = b + 1; // south-east
      const e = a + 1; // north-east
      index.set([a, b, e, b, d, e], k);
      k += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

async function loadPixels(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  // Height is encoded in exact RGB values: no colour management, no premultiplication.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export interface Terrain {
  heightfield: Heightfield;
  mesh: THREE.Mesh;
  minHeight: number;
  maxHeight: number;
}

export async function loadTerrain(
  manifest: WorldManifest,
  frame: WorldFrame,
  stride: number,
  maxAnisotropy: number,
): Promise<Terrain> {
  const terrainLayer = manifest.layers.terrain;
  const groundLayer = manifest.layers.ground;
  if (!terrainLayer || !groundLayer) throw new Error('City data is missing terrain layers');

  const bounds = frame.bounds;
  const [pixels, ground] = await Promise.all([
    loadPixels(DATA_URL + terrainLayer.file),
    new THREE.TextureLoader().loadAsync(DATA_URL + groundLayer.file),
  ]);

  const heightfield = new Heightfield(
    decodeTerrainRgb(pixels.data, pixels.width * pixels.height),
    pixels.width,
    pixels.height,
    terrainLayer.resolution,
    bounds.minX,
    bounds.minZ,
  );

  ground.colorSpace = THREE.SRGBColorSpace;
  ground.flipY = false;
  ground.anisotropy = maxAnisotropy;

  const geometry = buildTerrainGeometry(heightfield, stride, {
    west: bounds.minX,
    north: bounds.minZ,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxZ - bounds.minZ,
  });
  const material = new THREE.MeshStandardMaterial({ map: ground, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';

  return {
    heightfield,
    mesh,
    minHeight: terrainLayer.minHeight,
    maxHeight: terrainLayer.maxHeight,
  };
}
