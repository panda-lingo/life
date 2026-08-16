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
  dark: 0x2b2b2b,
  beige: 0xe6d3a8,
  grey: 0xb0b0b0,
  orange: 0xc97a4f,
  silver: 0xc0c0c0,
};

const P = (w, h, d, color) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
const C = (r, h, seg, color, emissive = 0x000000) => new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), new THREE.MeshStandardMaterial({ color, emissive }));
const CYL = (r, h, seg, color) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), new THREE.MeshStandardMaterial({ color }));
const I = (r, d, color) => new THREE.Mesh(new THREE.IcosahedronGeometry(r, d), new THREE.MeshStandardMaterial({ color }));
const S = (r, seg, color) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2)), new THREE.MeshStandardMaterial({ color }));

const FACTORIES = {
  // ---------- generic ----------
  'table': () => P(1.2, 0.7, 0.7, COLORS.wood),
  'chair': () => P(0.5, 1, 0.5, COLORS.metal),
  'counter': () => P(3, 1.0, 0.6, COLORS.beige),
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

  // ---------- cafe ----------
  'cafe-counter': () => P(3, 1.1, 0.7, COLORS.beige),
  'cafe-table-round': () => CYL(0.6, 0.72, 16, COLORS.wood),
  'cafe-table-square': () => P(0.9, 0.72, 0.9, COLORS.wood),
  'chair-wood': () => P(0.5, 0.9, 0.5, COLORS.wood),
  'stool': () => CYL(0.25, 0.6, 12, COLORS.woodDark),
  'potted-plant': () => {
    const g = new THREE.Group();
    g.add(P(0.3, 0.3, 0.3, COLORS.woodDark));
    const top = I(0.35, 0, COLORS.green); top.position.y = 0.4; g.add(top);
    return g;
  },
  'hanging-plant': () => I(0.3, 0, COLORS.green),
  'cafe-pendant': () => C(0.25, 0.4, 10, COLORS.yellow, 0x553300),
  'floor-lamp': () => C(0.3, 1.2, 12, COLORS.yellow, 0x553300),

  // ---------- office ----------
  'office-desk': () => P(1.6, 0.8, 0.7, COLORS.wood),
  'standing-desk': () => P(1.4, 1.0, 0.6, COLORS.woodDark),
  'office-chair': () => P(0.5, 1.0, 0.5, COLORS.dark),
  'projector-screen': () => P(2.0, 1.2, 0.05, COLORS.white),
  'filing-cabinet': () => P(0.6, 1.4, 0.6, COLORS.grey),
  'succulent': () => I(0.2, 0, COLORS.green),

  // ---------- home-office ----------
  'armchair': () => P(0.8, 0.9, 0.8, COLORS.fabric),
  'desk-lamp': () => C(0.15, 0.4, 10, COLORS.yellow, 0x553300),

  // ---------- park ----------
  'park-bench': () => P(1.6, 0.5, 0.5, COLORS.woodDark),
  'picnic-table': () => P(1.4, 0.7, 1.2, COLORS.wood),
  'tree-round': () => {
    const g = new THREE.Group();
    g.add(CYL(0.15, 1.2, 8, COLORS.woodDark));
    const crown = S(0.6, 12, COLORS.green); crown.position.y = 1.4; g.add(crown);
    return g;
  },
  'tree-pine': () => C(0.6, 1.8, 12, 0x2a6a2a),
  'street-lamp': () => {
    const g = new THREE.Group();
    g.add(CYL(0.08, 2.2, 8, COLORS.metal));
    const head = C(0.2, 0.4, 10, COLORS.yellow, 0x553300); head.position.y = 2.4; g.add(head);
    return g;
  },
  'fountain': () => {
    const g = new THREE.Group();
    g.add(CYL(0.8, 0.4, 16, COLORS.grey));
    const water = S(0.4, 12, COLORS.glass); water.position.y = 0.4; g.add(water);
    return g;
  },
  'statue': () => P(0.4, 1.2, 0.4, COLORS.grey),
  'bike-rack': () => P(0.8, 0.5, 0.1, COLORS.metal),

  // ---------- restaurant ----------
  'restaurant-table': () => CYL(0.7, 0.72, 16, COLORS.woodDark),
  'dining-chair': () => P(0.5, 0.9, 0.5, COLORS.woodDark),
  'bar-counter': () => P(2.5, 1.1, 0.6, COLORS.woodDark),
  'candle': () => C(0.1, 0.3, 8, COLORS.yellow, 0x553300),

  // ---------- apartment ----------
  'bed': () => P(2.0, 0.5, 1.6, 0x8a9ac0),
  'sofa-bed': () => P(2.0, 0.6, 1.4, COLORS.fabric),
  'wardrobe': () => P(1.2, 2.0, 0.6, COLORS.woodDark),
};

/**
 * @param {string} id - prop id from manifest.json
 * @returns {Promise<THREE.Object3D>} - mesh, ready to position and add to scene
 */
export async function makeProp(id) {
  const factory = FACTORIES[id];
  if (!factory) return P(0.5, 0.5, 0.5, 0xff00ff);
  return factory();
}

/** Sync variant for tests + places where we already have the mesh. */
export function makePropSync(id) {
  const factory = FACTORIES[id];
  return factory ? factory() : P(0.5, 0.5, 0.5, 0xff00ff);
}

export const KNOWN_PROPS = Object.keys(FACTORIES);
