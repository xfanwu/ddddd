'use strict';

/**
 * An ASCII rhinoceros beetle that walks a branch as the download progresses.
 *
 * The branch *is* the progress bar: the beetle stands on the fill boundary.
 * Every so often it opens its elytra, unfolds its wings, hops, and lands back
 * exactly where the progress is. Flight is decorative and never advances
 * progress by itself.
 *
 * Rendering is one <pre> whose textContent is swapped ~7 times a second. Frames
 * keep a constant line count and width so the scene cannot jitter.
 */

// Side view, horn at the upper left, six splayed legs underneath.
const WALK_A = [
  '  ___',
  ' /   \\____',
  '/  o      \\____',
  '\\__           \\__',
  '   \\_____________\\',
  '  / |   |   | \\',
];
const WALK_B = [
  '  ___',
  ' /   \\____',
  '/  o      \\____',
  '\\__           \\__',
  '   \\_____________\\',
  '  \\ |   |   | /',
];
// Elytra lift and the membranous wings unfold behind the shell.
const WINGS = [
  '  ___            \\  /',
  ' /   \\____      \\/',
  '/  o      \\____',
  '\\__           \\__',
  '   \\____/\\_______\\',
  '  / |   |   | \\',
];
const FLY_A = [
  '  ___     \\   /',
  ' /   \\____ \\ /',
  '/  o      \\____',
  '\\__           \\__',
  '   \\_____________\\',
  '     ~    ~',
];
const FLY_B = [
  '  ___     /   \\',
  ' /   \\____ \\ /',
  '/  o      \\____',
  '\\__           \\__',
  '   \\_____________\\',
  '    ~    ~',
];

const ART_WIDTH = Math.max(...[WALK_A, WALK_B, WINGS, FLY_A, FLY_B].flat().map((l) => l.length));
const ART_HEIGHT = WALK_A.length;
const AIR_ROWS = 7;
const FRAME_MS = 140;

function pad(line) {
  return line + ' '.repeat(Math.max(0, ART_WIDTH - line.length));
}

class BeetleScene {
  constructor(element, { width = 56, reducedMotion = false } = {}) {
    this.el = element;
    this.width = width;
    this.reducedMotion = reducedMotion;
    this.mode = 'idle';
    this.progress = 0;
    this.tickIndex = 0;
    this.flight = null;
    this.nextFlyAt = Date.now() + 6000 + Math.random() * 8000;
    this.lastFrame = '';
    this.draw(Date.now());
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    if (value) this.flight = null;
  }

  destroy() {
    clearInterval(this.timer);
  }

  /**
   * @param {{mode: string, progress: number}} next
   * mode: idle | probing | walking | done | error
   */
  update(next) {
    if (next.mode !== this.mode) {
      this.flight = null;
      this.nextFlyAt = Date.now() + 6000 + Math.random() * 10000;
    }
    this.mode = next.mode;
    this.progress = Math.max(0, Math.min(1, next.progress || 0));
  }

  tick() {
    const now = Date.now();

    if (this.mode === 'walking' && !this.flight && !this.reducedMotion && now >= this.nextFlyAt) {
      this.flight = { start: now };
    }

    if (this.flight) {
      const elapsed = now - this.flight.start;
      if (elapsed > 1900) {
        this.flight = null;
        this.nextFlyAt = now + 9000 + Math.random() * 16000;
      }
    }

    this.tickIndex += 1;
    this.draw(now);
  }

  flightPose() {
    if (!this.flight) return null;

    const t = Date.now() - this.flight.start;
    const flap = this.tickIndex % 2 === 0 ? FLY_A : FLY_B;

    if (t < 350) return { art: WINGS, y: 0, x: 0 };
    if (t < 800) return { art: flap, y: 1, x: 0 };
    if (t < 1400) return { art: flap, y: 2, x: 2 };
    if (t < 1700) return { art: flap, y: 1, x: 1 };
    return { art: WINGS, y: 0, x: 0 };
  }

  currentArt() {
    if (this.mode === 'done' || this.mode === 'error') return WALK_A;
    const pose = this.flightPose();
    if (pose) return pose.art;
    return this.tickIndex % 2 === 0 ? WALK_A : WALK_B;
  }

  branch() {
    if (this.mode === 'probing') return '╌'.repeat(this.width);

    const filled = Math.round(this.progress * (this.width - 1));
    const rest = Math.max(0, this.width - filled - 1);
    const head = this.mode === 'error' ? '╴' : '╸';
    return '━'.repeat(filled) + head + '─'.repeat(rest);
  }

  draw(now) {
    const art = this.currentArt();
    const pose = this.flightPose();
    const flyY = pose ? pose.y : 0;
    const flyX = pose ? pose.x : 0;

    const rows = Array.from({ length: AIR_ROWS }, () => ' '.repeat(this.width));

    const travel = Math.max(1, this.width - ART_WIDTH);
    const left = Math.max(0, Math.min(travel, Math.round(this.progress * travel) + flyX));
    const top = Math.max(0, AIR_ROWS - ART_HEIGHT - flyY);

    art.forEach((line, index) => {
      const rowIndex = top + index;
      if (rowIndex < 0 || rowIndex >= AIR_ROWS) return;
      rows[rowIndex] = ' '.repeat(left) + pad(line);
    });

    rows.push(this.branch());

    const frame = rows.join('\n');
    if (frame !== this.lastFrame) {
      this.el.textContent = frame;
      this.lastFrame = frame;
    }
  }
}

window.BeetleScene = BeetleScene;
