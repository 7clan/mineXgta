import * as THREE from 'three';
import { mulberry32 } from './constants';

/**
 * Project Hyperion — police air support (5-star wanted level).
 *
 * A smooth photoreal-style chopper that orbits the player, sweeps a
 * volumetric searchlight cone, blinks red/blue belly flashers and strafes
 * the player with door-gun bursts (combat handled by the game orchestrator).
 * Motion: parametric orbit with banking, altitude above nearby rooftops,
 * rotor spin and subtle bob. Underground targets break its line of sight —
 * tunnels are safe houses.
 */
export class Helicopter {
  group = new THREE.Group();
  /** World position of the door gun (nose). */
  readonly muzzle = new THREE.Object3D();

  private rotorMain = new THREE.Group();
  private rotorTail = new THREE.Group();
  private flashers: THREE.Mesh[] = [];
  private light: THREE.SpotLight;
  private lightTarget = new THREE.Object3D();
  private cone: THREE.Mesh;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private rng = mulberry32(4242);
  private angle = Math.random() * Math.PI * 2;
  private t = 0;
  private yaw = 0;
  private sweepT = 0;

  constructor(scene: THREE.Scene) {
    const dark = new THREE.MeshStandardMaterial({ color: 0x12161d, roughness: 0.38, metalness: 0.62 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.45, metalness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c151c, roughness: 0.06, metalness: 0.92 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.9 });
    const blade = new THREE.MeshStandardMaterial({ color: 0x191c22, roughness: 0.5, metalness: 0.4 });
    this.mats.push(dark, mid, glass, tire, blade);

    // Fuselage — smooth ellipsoid body, nose at +z
    const bodyGeo = new THREE.SphereGeometry(1, 26, 18);
    bodyGeo.scale(1.12, 1.02, 2.75);
    const body = new THREE.Mesh(bodyGeo, dark);
    body.castShadow = true;
    this.group.add(body);
    this.geos.push(bodyGeo);

    // Cockpit canopy
    const canopyGeo = new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
    canopyGeo.scale(0.82, 0.72, 1.15);
    const canopy = new THREE.Mesh(canopyGeo, glass);
    canopy.position.set(0, 0.42, 1.25);
    this.group.add(canopy);
    this.geos.push(canopyGeo);

    // Belly white band (police livery)
    const bandGeo = new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.2);
    bandGeo.scale(1.13, 1.03, 2.76);
    const band = new THREE.Mesh(bandGeo, new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.5, metalness: 0.3 }));
    this.group.add(band);
    this.geos.push(bandGeo);
    this.mats.push(band.material as THREE.Material);

    // Tail boom (tapered cylinder, -z)
    const boomGeo = new THREE.CylinderGeometry(0.14, 0.4, 4.7, 12);
    boomGeo.rotateX(Math.PI / 2);
    const boom = new THREE.Mesh(boomGeo, mid);
    boom.position.set(0, 0.24, -3.5);
    this.group.add(boom);
    this.geos.push(boomGeo);

    // Tail fin + stabilizer (flattened ellipsoids — smooth, not blocky)
    const finGeo = new THREE.SphereGeometry(1, 12, 10);
    finGeo.scale(0.07, 0.85, 0.5);
    const fin = new THREE.Mesh(finGeo, mid);
    fin.position.set(0, 0.85, -5.5);
    const stabGeo = new THREE.SphereGeometry(1, 12, 10);
    stabGeo.scale(0.5, 0.06, 0.3);
    const stab = new THREE.Mesh(stabGeo, mid);
    stab.position.set(0, 0.3, -5.1);
    this.group.add(fin, stab);
    this.geos.push(finGeo, stabGeo);

    // Tail rotor (spins around X — blades live in the YZ plane)
    const tbGeo = new THREE.BoxGeometry(0.05, 1.45, 0.2);
    const tb1 = new THREE.Mesh(tbGeo, blade);
    const tb2 = new THREE.Mesh(tbGeo, blade);
    tb2.rotation.x = Math.PI / 2;
    const hubGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.14, 8);
    hubGeo.rotateZ(Math.PI / 2);
    const hub = new THREE.Mesh(hubGeo, mid);
    this.rotorTail.add(tb1, tb2, hub);
    this.rotorTail.position.set(0.26, 0.35, -5.45);
    this.group.add(this.rotorTail);
    this.geos.push(tbGeo, hubGeo);

    // Main rotor: hub + 4 blades
    const mhGeo = new THREE.CylinderGeometry(0.2, 0.24, 0.42, 10);
    const mast = new THREE.Mesh(mhGeo, mid);
    mast.position.y = 1.05;
    const bladeGeo = new THREE.BoxGeometry(0.3, 0.05, 7.4);
    this.geos.push(mhGeo, bladeGeo);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(bladeGeo, blade);
      b.rotation.y = (i * Math.PI) / 2;
      const arm = new THREE.Group();
      arm.add(b);
      b.position.z = 3.55;
      this.rotorMain.add(arm);
    }
    this.rotorMain.position.y = 1.3;
    this.group.add(mast, this.rotorMain);

    // Skids + struts
    const skidGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.4, 8);
    skidGeo.rotateX(Math.PI / 2);
    const strutGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.62, 6);
    this.geos.push(skidGeo, strutGeo);
    for (const sx of [-0.78, 0.78]) {
      const skid = new THREE.Mesh(skidGeo, tire);
      skid.position.set(sx, -1.32, 0.1);
      this.group.add(skid);
      for (const [dx, dz] of [
        [-0.2, 0.95],
        [0.2, 0.95],
        [-0.2, -0.75],
        [0.2, -0.75],
      ]) {
        const st = new THREE.Mesh(strutGeo, mid);
        st.position.set(sx + dx * 0.28, -0.98, dz);
        st.rotation.z = dx > 0 ? -0.25 : 0.25;
        this.group.add(st);
      }
    }

    // Belly red/blue flashers
    const redM = new THREE.MeshStandardMaterial({ color: 0x5a0806, emissive: 0xff2418, emissiveIntensity: 2.4 });
    const blueM = new THREE.MeshStandardMaterial({ color: 0x061a5a, emissive: 0x2a5aff, emissiveIntensity: 0.2 });
    const flGeo = new THREE.SphereGeometry(0.13, 8, 6);
    this.geos.push(flGeo);
    this.mats.push(redM, blueM);
    const fr = new THREE.Mesh(flGeo, redM);
    fr.position.set(-0.5, -1.02, 0.4);
    const fb = new THREE.Mesh(flGeo, blueM);
    fb.position.set(0.5, -1.02, 0.4);
    this.group.add(fr, fb);
    this.flashers.push(fr, fb);

    // Searchlight + volumetric cone
    this.light = new THREE.SpotLight(0xfff1c4, 2600, 230, 0.3, 0.45, 1.15);
    this.light.position.set(0, -1.05, 1.1);
    this.group.add(this.light);
    this.group.add(this.lightTarget);
    this.light.target = this.lightTarget;
    const coneGeo = new THREE.CylinderGeometry(0.42, 10.5, 34, 20, 1, true);
    coneGeo.translate(0, -17, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffe9b8,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.cone = new THREE.Mesh(coneGeo, coneMat);
    this.cone.position.copy(this.light.position);
    this.cone.renderOrder = 7;
    this.group.add(this.cone);
    this.geos.push(coneGeo);
    this.mats.push(coneMat);

    // Door gun muzzle anchor at the nose
    this.muzzle.position.set(0, -0.55, 2.6);
    this.group.add(this.muzzle);

    this.group.scale.setScalar(1.15);
    scene.add(this.group);
    scene.add(this.lightTarget);
  }

  get pos(): THREE.Vector3 {
    return this.group.position;
  }

  /**
   * Orbit the target. `minAlt` keeps the chopper above nearby rooftops.
   * `surfaceTarget` = where to point the searchlight (ground clamped).
   */
  update(dt: number, target: THREE.Vector3, minAlt: number): void {
    this.t += dt;
    this.sweepT += dt;
    this.angle += 0.21 * dt;
    const radius = 64 + Math.sin(this.t * 0.23) * 11;
    const alt = Math.max(36, minAlt) + Math.sin(this.t * 0.4) * 3.5;
    const desiredX = target.x + Math.cos(this.angle) * radius;
    const desiredZ = target.z + Math.sin(this.angle) * radius;
    const prevX = this.group.position.x;
    const prevZ = this.group.position.z;
    const k = 1 - Math.exp(-1.5 * dt);
    this.group.position.x += (desiredX - this.group.position.x) * k;
    this.group.position.z += (desiredZ - this.group.position.z) * k;
    this.group.position.y += (alt - this.group.position.y) * k;
    this.group.position.y += Math.sin(this.t * 1.7) * 0.06; // rotor bob

    // Face the direction of travel, bank into the orbit
    const vx = this.group.position.x - prevX;
    const vz = this.group.position.z - prevZ;
    if (vx * vx + vz * vz > 1e-6) {
      const targetYaw = Math.atan2(vx, vz);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 3 * dt);
    }
    this.group.rotation.y = this.yaw;
    this.group.rotation.z = 0.2; // bank toward the orbit center
    this.group.rotation.x = -0.05;

    // Rotors
    this.rotorMain.rotation.y += 27 * dt;
    this.rotorTail.rotation.x += 46 * dt;

    // Belly flashers alternate at 4 Hz
    const phase = Math.floor(this.t * 4) % 2;
    (this.flashers[0].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 0 ? 3.4 : 0.12;
    (this.flashers[1].material as THREE.MeshStandardMaterial).emissiveIntensity = phase === 1 ? 3.4 : 0.12;

    // Searchlight sweeps a lazy circle around the target
    const sweepR = 2.5 + Math.sin(this.sweepT * 0.9) * 2.2;
    const sweepA = this.sweepT * 1.35;
    this.lightTarget.position.set(
      target.x + Math.cos(sweepA) * sweepR - this.group.position.x,
      Math.max(target.y, 0) + 0.2 - this.group.position.y,
      target.z + Math.sin(sweepA) * sweepR - this.group.position.z
    );
    // Orient the volumetric cone straight down toward the beam target
    const beamDir = this.lightTarget.position.clone().sub(this.light.position).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), beamDir);
    this.cone.quaternion.copy(quat);
    (this.cone.material as THREE.MeshBasicMaterial).opacity = 0.042 + 0.02 * (0.5 + 0.5 * Math.sin(this.t * 5.3));
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    scene.remove(this.lightTarget);
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
