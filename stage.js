// A zoomable, pannable photo view. With drawable: true it also lets the user paint a mask.
// Strokes are stored in full-resolution photo pixels, so they stay exact at any zoom.

const MAX_WORK = 2048; // the on-screen copy of the photo is at most this many pixels on its long side
const MAX_ZOOM = 12;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class CanvasStage {
  constructor({ viewport, stage, image, mask = null, cursor = null, drawable = false, onChange = () => {} }) {
    this.vp = viewport;
    this.stage = stage;
    this.img = image;
    this.maskCv = mask;
    this.cursor = cursor;
    this.drawable = drawable;
    this.onChange = onChange;
    this.ictx = image.getContext('2d');
    this.mctx = mask ? mask.getContext('2d') : null;

    this.fullW = this.fullH = this.workW = this.workH = 1;
    this.k = 1;      // work pixels per photo pixel
    this.fs = 1;     // screen pixels per work pixel when fitted
    this.z = 1;      // zoom on top of fit, 1..MAX_ZOOM
    this.tx = 0;
    this.ty = 0;
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this.brushPx = 48; // brush diameter in screen pixels
    // The mask colour is a design token, read from CSS so a rebrand needs no code change.
    this.maskColor = getComputedStyle(document.documentElement).getPropertyValue('--color-mask').trim() || 'currentColor';
    this.pointers = new Map();
    this.gesture = null;
    this.pan = null;
    this.spaceDown = false;
    this._bind();
  }

  // ---- setup ----------------------------------------------------------------------------------

  setDimensions(fullW, fullH) {
    this.fullW = fullW;
    this.fullH = fullH;
    this.k = Math.min(1, MAX_WORK / Math.max(fullW, fullH));
    this.workW = Math.max(1, Math.round(fullW * this.k));
    this.workH = Math.max(1, Math.round(fullH * this.k));
    for (const cv of [this.img, this.maskCv]) {
      if (!cv) continue;
      cv.width = this.workW;
      cv.height = this.workH;
      cv.style.width = this.workW + 'px';
      cv.style.height = this.workH + 'px';
    }
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this.fit();
    this._emit();
  }

  /** Draws any canvas or bitmap, scaled to the on-screen copy. */
  drawImage(src) {
    this.ictx.clearRect(0, 0, this.workW, this.workH);
    this.ictx.imageSmoothingEnabled = true;
    this.ictx.imageSmoothingQuality = 'high';
    this.ictx.drawImage(src, 0, 0, this.workW, this.workH);
  }

  fit() {
    const vw = this.vp.clientWidth, vh = this.vp.clientHeight;
    this.fs = Math.min(2, Math.min(vw / this.workW, vh / this.workH)) || 1;
    this.z = 1;
    this._center();
    this._apply();
  }

  // ---- brush and history -----------------------------------------------------------------------

  setBrush(px) { this.brushPx = px; }
  getStrokes() { return this.strokes.map((s) => ({ r: s.r, pts: s.pts.map((p) => [p[0], p[1]]) })); }
  hasMask() { return this.strokes.length > 0; }

  undo() {
    if (!this.strokes.length) return;
    this.redoStack.push(this.strokes.pop());
    this._redraw();
    this._emit();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.strokes.push(this.redoStack.pop());
    this._redraw();
    this._emit();
  }

  clearStrokes() {
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this._redraw();
    this._emit();
  }

  _emit() {
    this.onChange({
      hasMask: this.strokes.length > 0,
      canUndo: this.strokes.length > 0,
      canRedo: this.redoStack.length > 0,
    });
  }

  // ---- drawing on the mask layer ---------------------------------------------------------------

  _style(r) {
    const c = this.mctx;
    c.lineWidth = Math.max(1, r * 2 * this.k);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = c.fillStyle = this.maskColor;
  }

  _drawStroke(st) {
    if (!this.mctx) return;
    const c = this.mctx, k = this.k, p = st.pts;
    this._style(st.r);
    c.beginPath();
    if (p.length === 1) {
      c.arc(p[0][0] * k, p[0][1] * k, Math.max(0.5, st.r * k), 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.moveTo(p[0][0] * k, p[0][1] * k);
    for (let i = 1; i < p.length; i++) c.lineTo(p[i][0] * k, p[i][1] * k);
    c.stroke();
  }

  _drawSegment(a, b, r) {
    if (!this.mctx) return;
    const c = this.mctx, k = this.k;
    this._style(r);
    c.beginPath();
    c.moveTo(a[0] * k, a[1] * k);
    c.lineTo(b[0] * k, b[1] * k);
    c.stroke();
  }

  _redraw() {
    if (!this.mctx) return;
    this.mctx.clearRect(0, 0, this.workW, this.workH);
    for (const s of this.strokes) this._drawStroke(s);
    if (this.current) this._drawStroke(this.current);
  }

  // ---- coordinates and transform ---------------------------------------------------------------

  _scale() { return this.fs * this.z; }

  _toPhoto(clientX, clientY) {
    const r = this.vp.getBoundingClientRect();
    const s = this._scale();
    return [(clientX - r.left - this.tx) / s / this.k, (clientY - r.top - this.ty) / s / this.k];
  }

  _brushRadius() { return this.brushPx / 2 / (this._scale() * this.k); }

  _center() {
    const s = this._scale();
    this.tx = (this.vp.clientWidth - this.workW * s) / 2;
    this.ty = (this.vp.clientHeight - this.workH * s) / 2;
  }

  _clampPan() {
    const s = this._scale(), vw = this.vp.clientWidth, vh = this.vp.clientHeight;
    const sw = this.workW * s, sh = this.workH * s;
    this.tx = sw <= vw ? (vw - sw) / 2 : clamp(this.tx, vw - sw, 0);
    this.ty = sh <= vh ? (vh - sh) / 2 : clamp(this.ty, vh - sh, 0);
  }

  _apply() {
    this._clampPan();
    this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this._scale()})`;
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.vp.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const s0 = this._scale();
    const u = (mx - this.tx) / s0, v = (my - this.ty) / s0;
    this.z = clamp(this.z * factor, 1, MAX_ZOOM);
    const s = this._scale();
    this.tx = mx - u * s;
    this.ty = my - v * s;
    this._apply();
  }

  // ---- input -----------------------------------------------------------------------------------

  _bind() {
    const vp = this.vp;
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
    vp.addEventListener('pointerdown', (e) => this._down(e));
    vp.addEventListener('pointermove', (e) => this._move(e));
    vp.addEventListener('pointerup', (e) => this._up(e));
    vp.addEventListener('pointercancel', (e) => this._up(e));
    vp.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && this.cursor) this.cursor.hidden = true; });
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && this.vp.offsetParent) this.spaceDown = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (!this.vp.clientWidth) return;
        if (this.z === 1) this.fit(); else this._apply();
      }).observe(vp);
    }
  }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.vp.setPointerCapture(e.pointerId); } catch (_) { /* not all browsers allow it */ }
    if (this.pointers.size === 2) {
      if (this.current) { this.current = null; this._redraw(); }
      this._startGesture();
      return;
    }
    const wantsPan = !this.drawable || e.button === 1 || this.spaceDown;
    if (wantsPan) {
      this.pan = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.vp.classList.add('panning');
      return;
    }
    const p = this._toPhoto(e.clientX, e.clientY);
    this.current = { r: this._brushRadius(), pts: [p] };
    this._drawStroke(this.current);
  }

  _move(e) {
    if (e.pointerType === 'mouse' && this.cursor && this.drawable) {
      const r = this.vp.getBoundingClientRect();
      const d = this.brushPx;
      this.cursor.hidden = false;
      this.cursor.style.width = this.cursor.style.height = d + 'px';
      this.cursor.style.transform = `translate(${e.clientX - r.left - d / 2}px, ${e.clientY - r.top - d / 2}px)`;
    }
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.gesture) { this._moveGesture(); return; }
    if (this.pan) {
      this.tx = this.pan.tx + (e.clientX - this.pan.x);
      this.ty = this.pan.ty + (e.clientY - this.pan.y);
      this._apply();
      return;
    }
    if (this.current) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const p = this._toPhoto(ev.clientX, ev.clientY);
        const last = this.current.pts[this.current.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this._scale() * this.k < 0.75) continue;
        this.current.pts.push(p);
        this._drawSegment(last, p, this.current.r);
      }
    }
  }

  _up(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    try { this.vp.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (this.gesture && this.pointers.size < 2) this.gesture = null;
    if (this.pan && this.pointers.size === 0) { this.pan = null; this.vp.classList.remove('panning'); }
    if (this.current && this.pointers.size === 0) {
      this.strokes.push(this.current);
      this.redoStack = [];
      this.current = null;
      this._emit();
    }
  }

  _startGesture() {
    const [a, b] = [...this.pointers.values()];
    const r = this.vp.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const s = this._scale();
    this.pan = null;
    this.gesture = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.z,
      u0: (mx - this.tx) / s, v0: (my - this.ty) / s,
    };
  }

  _moveGesture() {
    const [a, b] = [...this.pointers.values()];
    const r = this.vp.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const g = this.gesture;
    this.z = clamp(g.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0), 1, MAX_ZOOM);
    const s = this._scale();
    this.tx = mx - g.u0 * s;
    this.ty = my - g.v0 * s;
    this._apply();
  }
}
