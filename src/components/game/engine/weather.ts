/**
 * Project Hyperion — dynamic weather system.
 *
 * A three-state machine (clear → overcast → rain) with smoothed intensity,
 * a camera-anchored rain-streak LineSegments layer, and lightning strikes
 * (random flashes during rain, reported to the orchestrator for sky/sun
 * spikes + thunder audio). Zero assets: everything is generated geometry.
 *
 * The orchestrator reads `state` / `intensity` for sky/fog dimming and the
 * HUD weather chip, and reacts to `onLightning` events.
 */
import * as THREE from 'three';

export type WeatherState = 'clear' | 'overcast' | 'rain';

interface Drop {
  x: number;
  y: number;
  z: number;
  v: number; // fall speed m/s
}

const BOX = 30; // rain box half-extent around the camera (m)
const TOP = 26; // drop spawn height above camera
const FLOOR = 3; // kill plane below camera
const DROPS = 1500;
const STREAK = 0.55; // streak length (m)
const WIND = 2.6; // lateral slant (m/s)

export class Weather {
  state: WeatherState = 'clear';
  /** Smoothed severity 0..1 (0 clear, 0.35 overcast, 1 full rain). */
  intensity = 0;
  /** Seconds until the next state roll. */
  private nextIn = 70 + Math.random() * 60;
  /** Lightning strike timing. */
  private boltIn = 14 + Math.random() * 12;
  private flashT = 0;
  /** Callback for the orchestrator: sky/sun spike + thunder. */
  onLightning?: () => void;

  private scene: THREE.Scene;
  private lines: THREE.LineSegments;
  private mat: THREE.LineBasicMaterial;
  private pos: Float32Array;
  private drops: Drop[] = [];
  private windPhase = Math.random() * 10;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.pos = new Float32Array(DROPS * 2 * 3);
    for (let i = 0; i < DROPS; i++) {
      this.drops.push({
        x: (Math.random() * 2 - 1) * BOX,
        y: Math.random() * TOP,
        z: (Math.random() * 2 - 1) * BOX,
        v: 19 + Math.random() * 9,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.LineBasicMaterial({
      color: 0xaec4d8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  get raining(): boolean {
    return this.state === 'rain' && this.intensity > 0.4;
  }

  /** True for ~0.18s after each strike (orchestrator spikes the sun/sky). */
  get flashing(): boolean {
    return this.flashT > 0;
  }

  update(dt: number, cam: THREE.Vector3): void {
    // --- state machine -----------------------------------------------------
    this.nextIn -= dt;
    if (this.nextIn <= 0) {
      if (this.state === 'clear') {
        this.state = Math.random() < 0.62 ? 'rain' : 'overcast';
        this.nextIn = this.state === 'rain' ? 55 + Math.random() * 70 : 24 + Math.random() * 30;
      } else if (this.state === 'overcast') {
        this.state = Math.random() < 0.55 ? 'rain' : 'clear';
        this.nextIn = this.state === 'rain' ? 50 + Math.random() * 60 : 80 + Math.random() * 90;
      } else {
        this.state = Math.random() < 0.3 ? 'overcast' : 'clear';
        this.nextIn = this.state === 'clear' ? 85 + Math.random() * 100 : 25 + Math.random() * 25;
      }
    }
    const target = this.state === 'rain' ? 1 : this.state === 'overcast' ? 0.35 : 0;
    // Intensity eases over ~4s toward the state target.
    this.intensity += (target - this.intensity) * Math.min(1, dt * 0.4);

    // --- lightning ----------------------------------------------------------
    if (this.state === 'rain') {
      this.boltIn -= dt;
      if (this.boltIn <= 0) {
        this.boltIn = 9 + Math.random() * 17;
        this.flashT = 0.18;
        this.onLightning?.();
      }
    }
    if (this.flashT > 0) this.flashT -= dt;

    // --- rain streaks -------------------------------------------------------
    const show = this.intensity > 0.45;
    this.lines.visible = show;
    this.mat.opacity = Math.min(0.5, (this.intensity - 0.42) * 1.6);
    if (!show) return;
    this.windPhase += dt * 0.5;
    const windX = WIND * (0.6 + 0.4 * Math.sin(this.windPhase));
    const p = this.pos;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      d.y -= d.v * dt;
      d.x += windX * dt;
      // Wrap within the camera-anchored box.
      if (d.y < -FLOOR) {
        d.y = TOP - Math.random() * 4;
        d.x = (Math.random() * 2 - 1) * BOX;
        d.z = (Math.random() * 2 - 1) * BOX;
      }
      if (d.x > BOX) d.x -= BOX * 2;
      else if (d.x < -BOX) d.x += BOX * 2;
      if (d.z > BOX) d.z -= BOX * 2;
      else if (d.z < -BOX) d.z += BOX * 2;
      const o = i * 6;
      p[o] = cam.x + d.x;
      p[o + 1] = cam.y + d.y;
      p[o + 2] = cam.z + d.z;
      const slant = (windX / d.v) * STREAK;
      p[o + 3] = cam.x + d.x - slant;
      p[o + 4] = cam.y + d.y + STREAK;
      p[o + 5] = cam.z + d.z;
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}
