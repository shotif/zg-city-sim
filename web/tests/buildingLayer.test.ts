import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { BuildingLayer, Buildings, type BuildingIndex } from '../src/world/buildingLayer';

const index: BuildingIndex = {
  file: 'buildings.bin.gz',
  byteLength: 0,
  arrays: {},
  kinds: [
    'house',
    'residential',
    'commercial',
    'industrial',
    'civic',
    'religious',
    'minor',
    'other',
  ],
  roofShapes: ['flat', 'gabled'],
};

function layer(roofShape: number) {
  // One 10 x 20 m building at the origin, 9 m tall.
  const data = new Buildings(index, {
    points: new Float32Array([0, 0, 10, 0, 10, 20, 0, 20]),
    ringOffsets: new Uint32Array([0, 4]),
    buildingRings: new Uint32Array([0, 1]),
    height: new Float32Array([9]),
    minHeight: new Float32Array([0]),
    kind: new Uint8Array([0]),
    roofShape: new Uint8Array([roofShape]),
  });
  const buildingLayer = new BuildingLayer(data, () => 100);
  buildingLayer.update({
    target: new THREE.Vector3(5, 100, 10),
    viewHeight: 500,
    distance: 0,
    aspect: 1,
    perspective: false,
  });
  return buildingLayer;
}

function meshOf(l: BuildingLayer): THREE.Mesh {
  let mesh: THREE.Mesh | undefined;
  l.object.traverse((o) => {
    if (o instanceof THREE.Mesh) mesh = o;
  });
  if (!mesh) throw new Error('no mesh built');
  return mesh;
}

describe('BuildingLayer', () => {
  it('extrudes a flat-roofed building from the ground to its height', () => {
    const mesh = meshOf(layer(0));
    const box = new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    expect(box.min.y).toBeCloseTo(99.5); // sunk half a metre into the ground
    expect(box.max.y).toBeCloseTo(109);
    expect([box.min.x, box.max.x, box.min.z, box.max.z]).toEqual([0, 10, 0, 20]);
  });

  it('points wall normals outwards', () => {
    const mesh = meshOf(layer(0));
    const pos = mesh.geometry.getAttribute('position');
    const nor = mesh.geometry.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(nor.getY(i)) > 0.5) continue; // roof
      const outX = pos.getX(i) - 5;
      const outZ = pos.getZ(i) - 10;
      expect(nor.getX(i) * outX + nor.getZ(i) * outZ).toBeGreaterThan(0);
    }
  });

  it('puts a gabled roof with its ridge along the long side', () => {
    const mesh = meshOf(layer(1));
    const pos = mesh.geometry.getAttribute('position');
    const ridge: number[][] = [];
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 108.99) ridge.push([pos.getX(i), pos.getZ(i)]);
    }
    expect(ridge.length).toBeGreaterThan(0);
    // The ridge runs north-south through x = 5.
    for (const [x] of ridge) expect(x).toBeCloseTo(5);
  });
});
