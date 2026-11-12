/*! <dung-progress> — a pixel dung beetle progress bar. No dependencies.
 *
 *  <dung-progress value="42"></dung-progress>
 *
 *  Attributes   value="0–100" · scale="4" (screen px per art pixel) · indeterminate · no-label
 *  Property     el.value = 60
 *  Event        "complete" fires when the beetle reaches 100 and climbs the ball
 *  Theme        override any --dp-* custom property on the element (see :host below)
 */
(function () {
  'use strict';

  var H = 34;          // art height in pixels
  var G = 29;          // top row of the track
  var R_MIN = 4, R_MAX = 8;

  // K edge · B shell · H sheen · V second sheen
  var PUSH = [         // head down, rump up: how they really push — backwards
    '..........KKK...',
    '........KKBBBK..',
    '......KKHHBBBBK.',
    '.....KHHHBBBBBK.',
    '....KHHBBBBBBBK.',
    '....KHBBBBBBBVK.',
    '...KBBBBBBBBVK..',
    '...KKBBBBBBKK...',
    '..KBBKKKKKK.....',
    '.KHBBBK.........',
    '.KBBBK..........',
    'KKBKK...........',
    '.KK.............'
  ];
  var TOP = [          // standing on the ball, facing right
    '.....KKKK......',
    '...KKHHBBKK....',
    '..KHHBBBBBBK...',
    '.KHHBBBBBBBBKK.',
    'KHBBBBBBBBBKBBK',
    'KBBBBBBBBVBKBBK',
    '.KKBBBBBVBKKKK.',
    '...KKKKKKK.....'
  ];
  var FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
    '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001001001001', '8': '111101111101111',
    '9': '111101111001111', '%': '101001010100101'
  };
  // flecks baked into the ball so you can see it roll: [radius 0–1, angle]
  var FLECKS = [[.2, .4, 1], [.55, 1.9, 0], [.62, 3.4, 1], [.5, 5.1, 0], [.34, 2.9, 0], [.7, .2, 0], [.68, 4.3, 1]];

  function frac(v) { return v - Math.floor(v); }

  function line(put, x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, e = dx + dy;
    for (;;) {
      put(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }

  function leg(put, hx, hy, fx, fy, kx, ky, c) {
    var mx = (hx + fx) / 2 + kx, my = (hy + fy) / 2 + ky;
    line(put, hx, hy, mx, my, c);
    line(put, mx, my, fx, fy, c);
  }

  function sprite(put, rows, x, y, C, flip) {
    var map = { K: C.edge, B: C.shell, H: C.sheen, V: C.sheen2 };
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j], n = row.length;
      for (var i = 0; i < n; i++) {
        var ch = row[flip ? n - 1 - i : i];
        if (ch !== '.') put(x + i, y + j, map[ch]);
      }
    }
  }

  function geom(W, p) {
    var r = R_MIN + Math.round((R_MAX - R_MIN) * p);
    var x0 = 22, x1 = Math.max(x0, W - 2 - R_MAX);
    var bx = Math.round(x0 + (x1 - x0) * p);
    return { r: r, bx: bx, by: G - r, span: x1 - x0 };
  }

  // s: { p, angle, done, t, moving, dust[], label }   C: colours   put(x, y, colour)
  function render(put, W, s, C) {
    var g = geom(W, s.p), r = g.r, bx = g.bx, by = g.by, i, x, y;

    // track: a quiet dotted line; trail: a solid inked line behind the ball
    for (x = 1; x <= W - 2; x++) {
      var done = x < bx - Math.round((1 - s.p) * 21) || s.p >= 1;
      if (done) { put(x, G, C.fill); put(x, G + 1, C.fill); put(x, G + 2, C.fill2); }
      else if (x % 2 === 0) put(x, G + 1, C.track);
    }

    // dust
    for (i = 0; i < s.dust.length; i++) {
      var d = s.dust[i];
      put(Math.round(d.x), Math.round(d.y), C.dust);
    }

    // ball
    var flecks = [];
    for (i = 0; i < FLECKS.length; i++) {
      var f = FLECKS[i], a = f[1] + s.angle;
      flecks.push([Math.floor(Math.cos(a) * f[0] * r), Math.floor(Math.sin(a) * f[0] * r), f[2]]);
    }
    for (y = -r; y < r; y++) {
      for (x = -r; x < r; x++) {
        var nx = (x + .5) / r, ny = (y + .5) / r, dd = nx * nx + ny * ny;
        if (dd > 1) continue;
        var lit = -(nx * .55 + ny * .83), c = C.ball;
        if (dd > Math.pow(1 - 1.15 / r, 2)) c = lit > .25 ? C.ball : C.ballDark;
        else if (lit > .42) c = C.ballLight;
        else if (lit < -.38) c = C.ballDark;
        for (i = 0; i < flecks.length; i++) {
          if (flecks[i][0] === x && flecks[i][1] === y && dd < .7) c = flecks[i][2] ? C.ballLight : C.ballDark;
        }
        put(bx + x, by + y, c);
      }
    }

    var px = bx - r - 15, py = G - 13;         // pushing pose origin
    if (s.done > 0) {
      // hop up and stand on the ball
      var e = s.done, k = e * e * (3 - 2 * e);
      var tx = bx - 8, ty = G - 2 * r - 10;
      var sx0 = px + 2, sy0 = G - 10;
      var cx = Math.round(sx0 + (tx - sx0) * k);
      var cy = Math.round(sy0 + (ty - sy0) * k - Math.sin(Math.PI * e) * 5);
      var beat = s.done >= 1 ? Math.floor(s.t / .45) : 0;
      var flip = beat % 4 >= 2;
      var hop = s.done >= 1 && beat % 2 === 1 ? 0 : (s.done >= 1 ? 1 : 0);
      cy += hop;
      // legs
      var lx = flip ? [3, 6, 9] : [5, 8, 11];
      for (i = 0; i < 3; i++) {
        var o = ((i + beat) % 2) ? 1 : -1;
        put(cx + lx[i], cy + 8, C.leg);
        put(cx + lx[i] + o, cy + 9, C.leg);
        if (hop === 0) put(cx + lx[i] + o, cy + 10, C.leg);
      }
      sprite(put, TOP, cx, cy, C, flip);
      // antennae
      var ax = flip ? cx : cx + 14;
      put(ax + (flip ? -1 : 1), cy + 4 - (beat % 2), C.leg);
      put(ax + (flip ? -2 : 2), cy + 3 - (beat % 2), C.leg);
      // sparkles
      if (s.done >= 1) {
        var S = [[-15, -19, 0], [-21, -10, 1], [-11, -27, 2], [6, -28, 3]];
        for (i = 0; i < S.length; i++) {
          var ph = frac(s.t * .9 + S[i][2] * .27), qx = bx + S[i][0], qy = G + S[i][1];
          if (qy < 1) qy = 1;
          if (ph < .5) put(qx, qy, C.spark);
          if (ph > .15 && ph < .35) { put(qx - 1, qy, C.spark); put(qx + 1, qy, C.spark); put(qx, qy - 1, C.spark); put(qx, qy + 1, C.spark); }
        }
      }
    } else {
      var u = frac(bx / 7), bob = s.moving && frac(bx / 3.5) > .5 ? 1 : 0;
      py += bob;
      var foot = function (ph, amp) {          // planted, then lifted and swung
        ph = frac(ph);
        return ph < .6 ? { x: amp - 2 * amp * (ph / .6), y: 0 }
                       : { x: -amp + 2 * amp * ((ph - .6) / .4), y: -1.4 * Math.sin(Math.PI * (ph - .6) / .4) };
      };
      var hind = function (ph, col, hx, hy) {  // hind feet walk the ball's surface
        var th = Math.PI + .5 + .42 * Math.sin(2 * Math.PI * ph);
        leg(put, hx, hy, bx + (r + .4) * Math.cos(th) - .5, by + (r + .4) * Math.sin(th) - .5, -1, -2, col);
      };
      var f1 = foot(u + .5, 2), m1 = foot(u, 2), f2 = foot(u, 2), m2 = foot(u + .5, 2);
      // far-side legs
      leg(put, px + 4, py + 9, px + 6 + f1.x, G - 1 + f1.y, 1, -1, C.legFar);
      leg(put, px + 8, py + 7, px + 11 + m1.x, G - 1 + m1.y, 1, -1, C.legFar);
      hind(u + .5, C.legFar, px + 13, py + 2);
      sprite(put, PUSH, px, py, C, false);
      // near-side legs
      leg(put, px + 3, py + 10, px + 3 + f2.x, G - 1 + f2.y, -1, -1, C.leg);
      leg(put, px + 7, py + 8, px + 9 + m2.x, G - 1 + m2.y, 1, 0, C.leg);
      hind(u, C.leg, px + 13, py + 5);
      // antenna
      var tw = !s.moving && frac(s.t / 3.2) > .9 ? 1 : 0;
      put(px - 1, py + 10 - tw, C.leg);
    }

    // numerals, top-left — the one corner the beetle never visits
    if (s.label) {
      var txt = s.label, ox = 2;
      for (i = 0; i < txt.length; i++) {
        var gph = FONT[txt[i]];
        if (gph) for (var q = 0; q < 15; q++) if (gph[q] === '1') put(ox + q % 3, 1 + (q / 3 | 0), C.ink);
        ox += 4;
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { render: render, geom: geom, H: H };
  if (typeof window === 'undefined' || !window.customElements) return;

  var VARS = {
    shell: '--dp-shell', sheen: '--dp-sheen', sheen2: '--dp-sheen-2', edge: '--dp-edge',
    leg: '--dp-leg', legFar: '--dp-leg-far', ball: '--dp-ball', ballLight: '--dp-ball-light',
    ballDark: '--dp-ball-dark', track: '--dp-track', track2: '--dp-track-shade', fill: '--dp-fill',
    fill2: '--dp-fill-shade', dust: '--dp-dust', ink: '--dp-ink', spark: '--dp-spark'
  };

  var CSS =
    ':host{display:block;width:100%;line-height:0;' +
    '--dp-shell:#1c1c1c;--dp-sheen:#5c5c5c;--dp-sheen-2:#3a3a3a;--dp-edge:#000;' +
    '--dp-leg:#000;--dp-leg-far:#8a8a8a;' +
    '--dp-ball:#8c8c8c;--dp-ball-light:#bdbdbd;--dp-ball-dark:#5e5e5e;' +
    '--dp-track:#cfcfcf;--dp-track-shade:#ececec;--dp-fill:#111;--dp-fill-shade:#9a9a9a;' +
    '--dp-dust:#b5b5b5;--dp-ink:#111;--dp-spark:#111}' +
    'canvas{display:block;image-rendering:crisp-edges;image-rendering:pixelated}';

  function DungProgress() {
    var el = Reflect.construct(HTMLElement, [], DungProgress);
    var root = el.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style><canvas aria-hidden="true"></canvas>';
    el._cv = root.querySelector('canvas');
    el._ctx = el._cv.getContext('2d');
    el._s = { p: 0, angle: 0, done: 0, t: 0, moving: false, dust: [], label: '' };
    el._target = 0; el._W = 0; el._acc = 0; el._hold = 0; el._fired = false; el._C = null; el._tick = 0;
    el._frame = el._frame.bind(el);
    return el;
  }
  DungProgress.prototype = Object.create(HTMLElement.prototype);
  DungProgress.prototype.constructor = DungProgress;
  Object.setPrototypeOf(DungProgress, HTMLElement);
  DungProgress.observedAttributes = ['value', 'scale', 'indeterminate', 'no-label'];

  var P = DungProgress.prototype;

  Object.defineProperty(P, 'value', {
    get: function () { return Math.max(0, Math.min(100, parseFloat(this.getAttribute('value')) || 0)); },
    set: function (v) { this.setAttribute('value', String(v)); }
  });

  P.connectedCallback = function () {
    var self = this;
    this.setAttribute('role', 'progressbar');
    this.setAttribute('aria-valuemin', '0');
    this.setAttribute('aria-valuemax', '100');
    this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._ro = new ResizeObserver(function () { self._size(); });
    this._ro.observe(this);
    this._sync(); this._size();
    this._s.p = this._mq.matches ? this._target : 0;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  };

  P.disconnectedCallback = function () {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
  };

  P.attributeChangedCallback = function (name) {
    if (name === 'scale') this._size();
    this._sync();
  };

  P._sync = function () {
    this._target = this.value / 100;
    if (this.hasAttribute('indeterminate')) this.removeAttribute('aria-valuenow');
    else this.setAttribute('aria-valuenow', String(Math.round(this.value)));
  };

  P._size = function () {
    var scale = Math.max(1, Math.round(parseFloat(this.getAttribute('scale')) || 4));
    var W = Math.max(48, Math.floor(this.clientWidth / scale));
    if (W === this._W && scale === this._scale) return;
    this._W = W; this._scale = scale;
    this._cv.width = W; this._cv.height = H;
    this._cv.style.width = W * scale + 'px';
    this._cv.style.height = H * scale + 'px';
  };

  P._colours = function () {
    var cs = getComputedStyle(this), C = {};
    for (var k in VARS) C[k] = cs.getPropertyValue(VARS[k]).trim() || '#000';
    this._C = C;
  };

  P._frame = function (now) {
    this._raf = requestAnimationFrame(this._frame);
    var s = this._s, dt = Math.min(.05, (now - this._last) / 1000), still = this._mq.matches;
    this._last = now; s.t += dt;
    if (!this._W) return;
    if (!this._C || this._tick++ % 30 === 0) this._colours();

    var before = geom(this._W, s.p).bx, loop = this.hasAttribute('indeterminate');
    if (loop) {
      if (s.p < 1) s.p = Math.min(1, s.p + dt / 4.5);
      else if ((this._hold += dt) > 1.6) { s.p = 0; s.done = 0; this._hold = 0; }
    } else {
      var delta = this._target - s.p, mag = Math.abs(delta);
      s.p += still ? delta : Math.sign(delta) * Math.min(mag, (.12 + mag * 2.2) * dt);
    }
    var g = geom(this._W, s.p), moved = g.bx - before;
    s.moving = Math.abs(loop ? 1 - s.p : this._target - s.p) > .0005;
    s.angle += moved / g.r;

    var top = s.p >= .999;
    s.done = still ? (top ? 1 : 0) : Math.max(0, Math.min(1, s.done + (top ? dt / .55 : -dt / .25)));
    if (still) s.t = 0;
    if (s.done >= 1 && !this._fired) { this._fired = true; this.dispatchEvent(new CustomEvent('complete', { bubbles: true })); }
    if (!top) this._fired = false;

    // dust kicked up by the front feet
    this._acc += Math.max(0, moved);
    if (this._acc >= 3 && s.done === 0 && !still) {
      this._acc = 0;
      s.dust.push({ x: g.bx - g.r - 13 + Math.random() * 4, y: G - 1, vx: -3 - Math.random() * 5, vy: -5 - Math.random() * 6, life: .35 + Math.random() * .3 });
    }
    for (var i = s.dust.length - 1; i >= 0; i--) {
      var d = s.dust[i];
      d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 14 * dt; d.life -= dt;
      if (d.life <= 0 || d.y > G - 1) s.dust.splice(i, 1);
    }

    s.label = loop || this.hasAttribute('no-label') ? '' : Math.round(s.p * 100) + '%';

    var ctx = this._ctx, W = this._W;
    ctx.clearRect(0, 0, W, H);
    render(function (x, y, c) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1);
    }, W, s, this._C);
  };

  if (!customElements.get('dung-progress')) customElements.define('dung-progress', DungProgress);
})();
