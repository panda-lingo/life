// Minimal Three.js renderer: low-poly stylized scene from a composition
// (kit + layout + props). The engine only renders what the director told it
// to render — it never touches AI directly. Prop geometry comes from
// src/engine/props.js (data-driven from assets/kits/manifest.json).

import * as THREE from 'three';
import { makeProp } from './props.js';

const SKY_DAY = 0xb4d8f0;
const SKY_EVENING = 0x3b3b5a;
const SKY_NIGHT = 0x151a2a;

let manifest = null;
async function loadManifest() {
  if (manifest) return manifest;
  const res = await fetch('../../assets/kits/manifest.json');
  manifest = await res.json();
  return manifest;
}

export async function listKits() {
  const m = await loadManifest();
  return m.kits.map((k) => ({ id: k.id, layouts: k.layouts, groundColor: k.groundColor }));
}

export function createEngine(container, opts = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr ?? 2);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_DAY);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(6, 5, 8);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = false;
  container.appendChild(renderer.domElement);

  const sun = new THREE.HemisphereLight(0xffffff, 0x444466, 0.9);
  scene.add(sun);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5, 8, 4);
  scene.add(dir);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x7ab07a }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const skyGeo = new THREE.SphereGeometry(80, 16, 12);
  const skyMat = new THREE.MeshBasicMaterial({ color: SKY_DAY, side: THREE.BackSide });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);

  let propGroup = new THREE.Group();
  scene.add(propGroup);

  function fit() {
    const w = container.clientWidth, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  fit();
  window.addEventListener('resize', fit);

  function clearProps() {
    propGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(propGroup);
    propGroup = new THREE.Group();
    scene.add(propGroup);
  }

  async function composeComposition(composition) {
    await loadManifest();
    const kit = manifest.kits.find((k) => k.id === composition.kit);
    if (!kit) return;
    ground.material.color.setHex(kit.groundColor);
    const layout = kit.layouts.find((l) => l.id === composition.layout) || kit.layouts[0];
    if (!layout) return;
    clearProps();
    layout.slots.forEach(async (slot, i) => {
      const propId = composition.props?.[slot.name] || slot.options[0];
      const mesh = await makeProp(propId);
      mesh.position.set(-4 + i * 2.5, 0.5, 0);
      propGroup.add(mesh);
    });
    applyLighting(composition.lighting || 'day');
  }

  function applyLighting(presetId) {
    const preset = manifest?.lightingPresets?.find((p) => p.id === presetId)
      || manifest?.lightingPresets?.[0];
    if (!preset) return;
    sun.intensity = preset.sunIntensity;
    dir.intensity = preset.dirIntensity;
    skyMat.color.setHex(preset.skyHex);
    scene.background.setHex(preset.skyHex);
  }

  function loop(fn) {
    let raf;
    function tick() { fn(); raf = requestAnimationFrame(tick); }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }

  function render() { renderer.render(scene, camera); }

  return { scene, camera, renderer, composeComposition, render, loop, listKits };
}
