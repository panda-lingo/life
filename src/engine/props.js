// Prop factory: maps the propId strings in the asset manifest to procedural
// Three.js geometry. Replace any factory here with a GLBLoader call (with
// a magenta placeholder fallback on error) once kit assets are pre-generated.

import * as THREE from 'three';

const COLORS = {
  wood: 0xc97a4f,
  woodDark: 0x6b4a2b,
  fabric: 0x8a5a3a,
  white: 0xffffff,
  green: 0x3a8a3a,
  yellow: 0xf2c14e,
  metal: 0x444444,
  glass: 0xa6c8e6,
  cyan: 0x88c0c0,
};

const P = (w, h, d, color) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
const C = (r, h, seg, color, emissive = 0x000000) => new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), new THREE.MeshStandardMaterial({ color, emissive }));
const I = (r, d, color) => new THREE.Mesh(new THREE.IcosahedronGeometry(r, d), new THREE.MeshStandardMaterial({ color }));
const S = (r, seg, color) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2)), new THREE.MeshStandardMaterial({ color }));

const FACTORIES = {
  'table': () => P(1.2, 0.7, 0.7, COLORS.wood),
  'chair': () => P(0.5, 1, 0.5, COLORS.metal),
  'counter': () => P(3, 1.0, 0.6, 0xe6d3a8),
  'lamp': () => C(0.4, 0.7, 12, COLORS.yellow, 0x553300),
  'plant': () => I(0.5, 0, COLORS.green),
  'bench': () => P(1.6, 0.5, 0.5, COLORS.woodDark),
  'desk': () => P(1.6, 0.8, 0.7, COLORS.wood),
  'sofa': () => P(2, 0.8, 1, COLORS.fabric),
  'meeting-chair': () => P(0.5, 1, 0.5, COLORS.metal),
  'whiteboard': () => P(2.5, 1.4, 0.1, COLORS.white),
  'bookshelf': () => P(1.4, 2.0, 0.4, COLORS.woodDark),
  'floor-cushion': () => S(0.5, 12, COLORS.cyan),
  'trashcan': () => C(0.3, 0.5, 12, COLORS.metal),
};

/**
 * @param {string} id - prop id from manifest.json
 * @returns {Promise<THREE.Object3D>} - mesh, ready to position and add to scene
 */
export async function makeProp(id) {
  const factory = FACTORIES[id];
  if (!factory) return P(0.5, 0.5, 0.5, 0xff00ff);             // magenta placeholder
  return factory();
}

/** Sync variant for tests + places where we already have the mesh. */
export function makePropSync(id) {
  const factory = FACTORIES[id];
  return factory ? factory() : P(0.5, 0.5, 0.5, 0xff00ff);
}

export const KNOWN_PROPS = Object.keys(FACTORIES);
