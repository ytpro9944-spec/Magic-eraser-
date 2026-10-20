// Synthetic photos with a known ground truth, so removal quality can be measured.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth colour field with optional fine grain. Returns RGBA, alpha 255. */
export function scene(w, h, { grain = 0, seed = 1, kind = 'gradient' } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let R, G, B;
      if (kind === 'gradient') {
        R = 20 + (x / w) * 200; G = 20 + (y / h) * 200; B = 110 + 60 * Math.sin(x / 90) * Math.cos(y / 70);
      } else if (kind === 'stripes') {
        const s = 0.5 + 0.5 * Math.sin((x * 0.9 + y * 0.35) / 6);
        R = 90 + 70 * s; G = 60 + 50 * s; B = 35 + 30 * s;
      } else { // blobs
        const a = Math.sin(x / 55) + Math.cos(y / 43) + Math.sin((x + y) / 71);
        R = 120 + 40 * a; G = 150 + 30 * Math.sin(a * 1.3); B = 100 + 50 * Math.cos(a);
      }
      const n = grain ? gauss() * grain : 0;
      px[i] = R + n; px[i + 1] = G + n; px[i + 2] = B + n; px[i + 3] = 255;
    }
  }
  return px;
}

export function withObject(truth, w, h, x0, y0, s, color = [220, 30, 30]) {
  const out = new Uint8ClampedArray(truth);
  for (let y = y0; y < y0 + s; y++) {
    for (let x = x0; x < x0 + s; x++) {
      const i = (y * w + x) * 4;
      out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2];
    }
  }
  return out;
}

export function squareMask(w, h, x0, y0, s, pad = 3) {
  const m = new Uint8Array(w * h);
  for (let y = Math.max(0, y0 - pad); y < Math.min(h, y0 + s + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(w, x0 + s + pad); x++) m[y * w + x] = 255;
  }
  return m;
}

/** Mean absolute error over the masked pixels, RGB only. */
export function maeInMask(a, b, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] < 128) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i * 4 + c] - b[i * 4 + c]);
    n += 3;
  }
  return sum / n;
}

/** Chebyshev distance from the masked square; used to find pixels that must not change. */
export function farFromSquare(w, h, x0, y0, s, margin) {
  const far = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.max(x0 - x, 0, x - (x0 + s - 1));
      const dy = Math.max(y0 - y, 0, y - (y0 + s - 1));
      if (Math.max(dx, dy) > margin) far.push(y * w + x);
    }
  }
  return far;
}

/** Standard deviation of the fine detail (pixel minus mean of its 4 neighbours) over a set of pixels. */
export function detailStd(px, w, indices) {
  let sum = 0, n = 0;
  for (const i of indices) {
    for (let c = 0; c < 3; c++) {
      const v = px[i * 4 + c] - (px[(i - 1) * 4 + c] + px[(i + 1) * 4 + c] + px[(i - w) * 4 + c] + px[(i + w) * 4 + c]) / 4;
      sum += v * v; n++;
    }
  }
  return Math.sqrt(sum / n / 1.25);
}
