// Free object removal. No dependencies. Runs in a Web Worker or in Node.
//
// Default engine, 'patch' (see inpaint-patch.js): copy texture from the photo with PatchMatch, match the
// colour at the edge of the hole, then a feathered blend back into the photo.
// Fallback and option, 'smooth': push-pull (multi-resolution) fill from the pixels around the hole, a few
// smoothing sweeps and grain matched to the surroundings. Used when the patch engine finds nothing to copy.
//
// Honest limit: both are classical. They continue textures, colours and lines well. They do not invent
// structure (faces, text, a person in front of a busy background). That needs an AI model (engine B,
// see architecture.md), which is not built.
//
// Contract: inpaint(rgba, mask, w, h) -> new Uint8ClampedArray(w * h * 4)
//   rgba  Uint8ClampedArray, RGBA, not modified
//   mask  Uint8Array, one byte per pixel, >= 128 means "remove this pixel"
// Pixels farther than a few pixels from the mask come back exactly as they went in.

import { patchFill } from './inpaint-patch.js';

export const WORK_LIMIT = 2048;   // smooth engine: longest side it works at
export const PATCH_LIMIT = 1024;  // patch engine: slower per pixel, so it works at a smaller size

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Square dilation of a 0/1 mask by radius r. */
export function dilate(src, w, h, r) {
  if (r <= 0) return Uint8Array.from(src);
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum > 0 ? 1 : 0;
      const add = x + 1 + r;
      if (add < w) sum += src[row + add];
      const rem = x - r;
      if (rem >= 0) sum -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum > 0 ? 1 : 0;
      const add = y + 1 + r;
      if (add < h) sum += tmp[add * w + x];
      const rem = y - r;
      if (rem >= 0) sum -= tmp[rem * w + x];
    }
  }
  return out;
}

/**
 * Blend weight per pixel: exactly 1 on the hole, falling to exactly 0 within 2f pixels outside it.
 * Integer arithmetic throughout, so 1 and 0 are exact and untouched pixels stay bit-for-bit equal.
 */
export function featherAlpha(hole, w, h, f) {
  const base = dilate(hole, w, h, f);
  const hc = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(f, w - 1); x++) sum += base[row + x];
    for (let x = 0; x < w; x++) {
      hc[row + x] = sum;
      const add = x + 1 + f;
      if (add < w) sum += base[row + add];
      const rem = x - f;
      if (rem >= 0) sum -= base[row + rem];
    }
  }
  const nx = new Int32Array(w);
  for (let x = 0; x < w; x++) nx[x] = Math.min(w - 1, x + f) - Math.max(0, x - f) + 1;
  const alpha = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(f, h - 1); y++) sum += hc[y * w + x];
    for (let y = 0; y < h; y++) {
      const ny = Math.min(h - 1, y + f) - Math.max(0, y - f) + 1;
      alpha[y * w + x] = sum / (nx[x] * ny);
      const add = y + 1 + f;
      if (add < h) sum += hc[add * w + x];
      const rem = y - f;
      if (rem >= 0) sum -= hc[rem * w + x];
    }
  }
  return alpha;
}

/** Area-average down to lw x lh, using only known pixels. Weight = fraction of known pixels. */
function downscaleKnown(rgba, hole, w, h, lw, lh) {
  const color = new Float32Array(lw * lh * 4);
  const wt = new Float32Array(lw * lh);
  for (let ly = 0; ly < lh; ly++) {
    const sy0 = Math.floor((ly * h) / lh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ly + 1) * h) / lh));
    for (let lx = 0; lx < lw; lx++) {
      const sx0 = Math.floor((lx * w) / lw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((lx + 1) * w) / lw));
      let known = 0, total = 0, r = 0, g = 0, b = 0, a = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          total++;
          const i = sy * w + sx;
          if (!hole[i]) {
            known++;
            const j = i * 4;
            r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; a += rgba[j + 3];
          }
        }
      }
      const o = ly * lw + lx;
      if (known) {
        color[o * 4] = r / known; color[o * 4 + 1] = g / known;
        color[o * 4 + 2] = b / known; color[o * 4 + 3] = a / known;
      }
      wt[o] = known / total;
    }
  }
  return { color, wt };
}

/** Push-pull fill. color: Float32 RGBA, wt: Float32 0..1 (1 = known). Fills in place, returns color. */
function pushPull(color, wt, w, h) {
  const levels = [{ c: color, wt, w, h }];
  let cur = levels[0];
  while (cur.w > 1 || cur.h > 1) {
    const nw = (cur.w + 1) >> 1, nh = (cur.h + 1) >> 1;
    const nc = new Float32Array(nw * nh * 4);
    const nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sw = 0, r = 0, g = 0, b = 0, a = 0, cnt = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = 2 * y + dy;
          if (sy >= cur.h) break;
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx;
            if (sx >= cur.w) break;
            const i = sy * cur.w + sx;
            const wi = cur.wt[i];
            cnt++;
            if (wi > 0) {
              sw += wi;
              r += wi * cur.c[i * 4]; g += wi * cur.c[i * 4 + 1];
              b += wi * cur.c[i * 4 + 2]; a += wi * cur.c[i * 4 + 3];
            }
          }
        }
        const o = y * nw + x;
        if (sw > 0) {
          nc[o * 4] = r / sw; nc[o * 4 + 1] = g / sw; nc[o * 4 + 2] = b / sw; nc[o * 4 + 3] = a / sw;
          nwt[o] = sw / cnt;
        }
      }
    }
    cur = { c: nc, wt: nwt, w: nw, h: nh };
    levels.push(cur);
  }
  const top = levels[levels.length - 1];
  if (top.wt[0] === 0) { top.c[0] = top.c[1] = top.c[2] = 128; top.c[3] = 255; }
  top.wt[0] = 1;

  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const fy = clamp(y * 0.5 - 0.25, 0, c.h - 1);
      const y0 = Math.floor(fy), y1 = Math.min(c.h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const wi = f.wt[i];
        if (wi >= 1) continue;
        const fx = clamp(x * 0.5 - 0.25, 0, c.w - 1);
        const x0 = Math.floor(fx), x1 = Math.min(c.w - 1, x0 + 1), tx = fx - x0;
        const a00 = (y0 * c.w + x0) * 4, a10 = (y0 * c.w + x1) * 4;
        const a01 = (y1 * c.w + x0) * 4, a11 = (y1 * c.w + x1) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top2 = c.c[a00 + ch] * (1 - tx) + c.c[a10 + ch] * tx;
          const bot2 = c.c[a01 + ch] * (1 - tx) + c.c[a11 + ch] * tx;
          const up = top2 * (1 - ty) + bot2 * ty;
          f.c[i * 4 + ch] = wi * f.c[i * 4 + ch] + (1 - wi) * up;
        }
        f.wt[i] = 1;
      }
    }
  }
  return levels[0].c;
}

/** A few Gauss-Seidel sweeps over the hole pixels only: removes blockiness left by the pull step. */
function smooth(c, w, h, idx, iters) {
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = i % w, y = (i - x) / w;
      const l = (y * w + (x > 0 ? x - 1 : x)) * 4;
      const r = (y * w + (x < w - 1 ? x + 1 : x)) * 4;
      const u = ((y > 0 ? y - 1 : y) * w + x) * 4;
      const d = ((y < h - 1 ? y + 1 : y) * w + x) * 4;
      for (let ch = 0; ch < 4; ch++) c[i * 4 + ch] = (c[l + ch] + c[r + ch] + c[u + ch] + c[d + ch]) * 0.25;
    }
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fine detail (texture, grain) in a ring of known pixels around the hole: one number per colour channel,
 * roughly the noise level on a 0-255 scale. Null if the ring is too small to say.
 */
export function ringDetail(known, isHole, w, h) {
  const ring = dilate(isHole, w, h, 10);
  const sumsq = [0, 0, 0];
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ring[i] || isHole[i]) continue;
      const l = i - 1, r = i + 1, u = i - w, d = i + w;
      if (isHole[l] || isHole[r] || isHole[u] || isHole[d]) continue;
      for (let ch = 0; ch < 3; ch++) {
        const res = known[i * 4 + ch] - (known[l * 4 + ch] + known[r * 4 + ch] + known[u * 4 + ch] + known[d * 4 + ch]) * 0.25;
        sumsq[ch] += res * res;
      }
      n++;
    }
  }
  if (n < 50) return null;
  return sumsq.map((s) => Math.sqrt(s / n / 1.25));
}

/** Adds noise to the filled area, sized to the fine detail found in a ring around the hole. */
function addGrain(c, known, isHole, w, h, idx, seed) {
  const detail = ringDetail(known, isHole, w, h);
  if (!detail) return;
  const sigma = detail.map((v) => Math.min(14, v) * 0.85);
  if (sigma[0] + sigma[1] + sigma[2] < 0.5) return;
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k] * 4;
    for (let ch = 0; ch < 3; ch++) c[i + ch] += sigma[ch] * gauss();
  }
}

/**
 * Makes a texture fill agree with the photo at the edge of the hole. Where a known pixel touches the hole,
 * the gap between that pixel and the fill just inside is measured, then spread smoothly across the whole
 * hole and added to the fill. Texture is kept; colour and brightness drift is removed.
 * Changes `filled` in place. Colour channels only.
 */
function matchBoundary(filled, known, wt, w, h) {
  const n = w * h;
  const D = new Float32Array(n * 4);
  const dw = new Float32Array(n);
  let rim = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (wt[i] < 0.999) continue;
      let cnt = 0, r = 0, g = 0, b = 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || wt[j] >= 0.999) continue;
        cnt++;
        r += known[i * 4] - filled[j * 4]; g += known[i * 4 + 1] - filled[j * 4 + 1]; b += known[i * 4 + 2] - filled[j * 4 + 2];
      }
      if (cnt) { D[i * 4] = r / cnt; D[i * 4 + 1] = g / cnt; D[i * 4 + 2] = b / cnt; dw[i] = 1; rim++; }
    }
  }
  if (!rim) return;
  const corr = pushPull(D, dw, w, h);
  for (let i = 0; i < n; i++) {
    if (wt[i] >= 0.999) continue;
    filled[i * 4] += corr[i * 4]; filled[i * 4 + 1] += corr[i * 4 + 1]; filled[i * 4 + 2] += corr[i * 4 + 2];
  }
}

export function inpaint(rgba, mask, w, h, opts = {}) {
  const engine = opts.engine ?? 'patch'; // 'patch' (copies texture from the photo) or 'smooth' (blur plus grain)
  const limit = opts.limit ?? (engine === 'patch' ? PATCH_LIMIT : WORK_LIMIT);
  const n = w * h;
  const out = new Uint8ClampedArray(rgba);
  const hole0 = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i] >= 128) { hole0[i] = 1; count++; }
  if (!count) return out;

  const long = Math.max(w, h);
  const holeD = dilate(hole0, w, h, clamp(Math.round(long * 0.003), 2, 5));
  const alpha = featherAlpha(holeD, w, h, clamp(Math.round(long * 0.004), 2, 8));

  const s = long > limit ? limit / long : 1;
  const lw = s < 1 ? Math.max(1, Math.round(w * s)) : w;
  const lh = s < 1 ? Math.max(1, Math.round(h * s)) : h;

  let color, wt;
  if (s < 1) {
    ({ color, wt } = downscaleKnown(rgba, holeD, w, h, lw, lh));
  } else {
    color = new Float32Array(n * 4);
    wt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!holeD[i]) {
        const j = i * 4;
        color[j] = rgba[j]; color[j + 1] = rgba[j + 1]; color[j + 2] = rgba[j + 2]; color[j + 3] = rgba[j + 3];
        wt[i] = 1;
      }
    }
  }

  const ln = lw * lh;
  const lowHole = new Uint8Array(ln);
  let nIdx = 0;
  for (let i = 0; i < ln; i++) if (wt[i] < 0.999) { lowHole[i] = 1; nIdx++; }
  const idx = new Int32Array(nIdx);
  for (let i = 0, k = 0; i < ln; i++) if (lowHole[i]) idx[k++] = i;
  const known = opts.grain === false ? null : color.slice();

  // Known trade-off, measured: on a noise-free smooth gradient the patch engine is a little worse than the
  // smooth fill (error 5.5 against 1.3 on a 0-255 scale). On structure and texture it is much better
  // (stripes 0.06 against 15.4). A flatness test to pick between them was tried and misread clean stripes as
  // flat, so it was dropped. Pass { engine: 'smooth' } to force the smooth fill.
  let filled = null;
  if (engine === 'patch') {
    // patchFill leaves color and wt alone, so the smooth fill below can still run if it finds nothing to copy
    filled = patchFill(color, wt, lw, lh, { init: (c, wv, pw, ph) => pushPull(c, wv, pw, ph), seed: opts.seed });
    if (filled && opts.matchEdge !== false) matchBoundary(filled, color, wt, lw, lh);
  }
  if (!filled) {
    filled = pushPull(color, wt, lw, lh);
    smooth(filled, lw, lh, idx, opts.smoothIters ?? 6);
    if (known) addGrain(filled, known, lowHole, lw, lh, idx, opts.seed ?? 0x9e3779b9);
  }

  if (s >= 1) {
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      if (a <= 0) continue;
      const j = i * 4;
      for (let ch = 0; ch < 4; ch++) out[j + ch] = rgba[j + ch] * (1 - a) + filled[j + ch] * a;
    }
  } else {
    const kx = lw / w, ky = lh / h;
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) * ky - 0.5, 0, lh - 1);
      const y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = alpha[i];
        if (a <= 0) continue;
        const fx = clamp((x + 0.5) * kx - 0.5, 0, lw - 1);
        const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
        const a00 = (y0 * lw + x0) * 4, a10 = (y0 * lw + x1) * 4;
        const a01 = (y1 * lw + x0) * 4, a11 = (y1 * lw + x1) * 4;
        const j = i * 4;
        for (let ch = 0; ch < 4; ch++) {
          const t = filled[a00 + ch] * (1 - tx) + filled[a10 + ch] * tx;
          const b = filled[a01 + ch] * (1 - tx) + filled[a11 + ch] * tx;
          out[j + ch] = rgba[j + ch] * (1 - a) + (t * (1 - ty) + b * ty) * a;
        }
      }
    }
  }
  return out;
}
