import * as THREE from 'three/webgpu';

import { DATA_URL, type WorldManifest } from '../manifest';
import type { WorldFrame } from './frame';
import { Heightfield, decodeTerrainRgb } from './heightfield';
import { TerrainLayer } from './terrainLod';

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
  /** The terrain as drawn, in tiles that get coarser with distance. */
  layer: TerrainLayer;
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

  const layer = new TerrainLayer(heightfield, stride, ground, {
    west: bounds.minX,
    north: bounds.minZ,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxZ - bounds.minZ,
  });

  return {
    heightfield,
    layer,
    minHeight: terrainLayer.minHeight,
    maxHeight: terrainLayer.maxHeight,
  };
}
