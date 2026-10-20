import test from 'node:test';
import assert from 'node:assert/strict';
import { inpaint, dilate, featherAlpha } from '../src/inpaint-core.js';
import { scene, withObject, squareMask, maeInMask, farFromSquare, detailStd } from './helpers.mjs';

const W = 600, H = 400, X0 = 270, Y0 = 170, S = 60;

test('dilate grows a single pixel into a square of the right size', () => {
  const w = 21, h = 21, src = new Uint8Array(w * h);
  src[10 * w + 10] = 1;
  const out = dilate(src, w, h, 3);
  let count = 0;
  for (const v of out) count += v;
  assert.equal(count, 49);
  assert.equal(out[7 * w + 7], 1);
  assert.equal(out[6 * w + 6], 0);
});

test('feather weight is exactly 1 on the hole and exactly 0 beyond twice the radius', () => {
  const w = 80, h = 60, f = 4, hole = new Uint8Array(w * h);
  for (let y = 25; y < 35; y++) for (let x = 35; x < 45; x++) hole[y * w + x] = 1;
  const a = featherAlpha(hole, w, h, f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.max(35 - x, 0, x - 44), dy = Math.max(25 - y, 0, y - 34), d = Math.max(dx, dy);
      const v = a[y * w + x];
      if (d === 0) assert.equal(v, 1, `inside at ${x},${y}`);
      else if (d > 2 * f) assert.equal(v, 0, `outside at ${x},${y}`);
      assert.ok(v >= 0 && v <= 1);
    }
  }
});

test('empty mask returns an identical copy and does not change the input', () => {
  const img = scene(50, 40);
  const copy = new Uint8ClampedArray(img);
  const out = inpaint(img, new Uint8Array(50 * 40), 50, 40);
  assert.deepEqual(out, img);
  assert.notEqual(out, img);
  assert.deepEqual(img, copy);
});

test('smooth engine: removes an object from a smooth photo; error is small and far pixels are untouched', () => {
  const truth = scene(W, H);
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const inputCopy = new Uint8ClampedArray(input);
  const out = inpaint(input, mask, W, H, { engine: 'smooth' });

  assert.deepEqual(input, inputCopy, 'input must not be modified');
  const before = maeInMask(input, truth, mask);
  const after = maeInMask(out, truth, mask);
  console.log(`  gradient: error in the hole ${before.toFixed(1)} -> ${after.toFixed(2)} (0-255 scale)`);
  assert.ok(after < 3, `error too high: ${after}`);

  for (const i of farFromSquare(W, H, X0, Y0, S, 30)) {
    for (let c = 0; c < 4; c++) assert.equal(out[i * 4 + c], input[i * 4 + c]);
  }
});

test('adds grain so a filled patch does not look like a smooth smudge', () => {
  const truth = scene(W, H, { grain: 6, seed: 7, kind: 'blobs' });
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const out = inpaint(input, mask, W, H);

  const holeIdx = [], ringIdx = [];
  for (let y = Y0 + 4; y < Y0 + S - 4; y++) for (let x = X0 + 4; x < X0 + S - 4; x++) holeIdx.push(y * W + x);
  for (let y = Y0 - 40; y < Y0 + S + 40; y++) {
    for (let x = X0 - 40; x < X0 + S + 40; x++) {
      if (x < X0 - 10 || x >= X0 + S + 10 || y < Y0 - 10 || y >= Y0 + S + 10) ringIdx.push(y * W + x);
    }
  }
  const inside = detailStd(out, W, holeIdx), around = detailStd(out, W, ringIdx);
  console.log(`  grain: detail ${inside.toFixed(2)} inside, ${around.toFixed(2)} around (truth is 6)`);
  assert.ok(inside > 0.5 * around && inside < 1.5 * around, `inside ${inside}, around ${around}`);
  assert.ok(maeInMask(out, truth, mask) < 14);
});

test('big crops are processed at reduced size and still blend back cleanly', () => {
  const truth = scene(W, H);
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const out = inpaint(input, mask, W, H, { limit: 128 });
  const err = maeInMask(out, truth, mask);
  console.log(`  reduced-size path: error ${err.toFixed(2)}`);
  assert.ok(err < 6, `error too high: ${err}`);
  for (const i of farFromSquare(W, H, X0, Y0, S, 30)) {
    for (let c = 0; c < 4; c++) assert.equal(out[i * 4 + c], input[i * 4 + c]);
  }
});

test('hole touching a corner or the whole image gives finite values', () => {
  const w = 64, h = 48, img = scene(w, h);
  const corner = new Uint8Array(w * h);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) corner[y * w + x] = 255;
  const a = inpaint(img, corner, w, h);
  assert.equal(a.length, w * h * 4);
  for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255);

  const all = inpaint(img, new Uint8Array(w * h).fill(255), w, h);
  assert.ok(all.every((v) => Number.isFinite(v)));

  const one = inpaint(new Uint8ClampedArray([10, 20, 30, 255]), new Uint8Array([255]), 1, 1);
  assert.equal(one.length, 4);
  assert.equal(one[3], 255);
});

test('transparent pixels around the hole stay transparent', () => {
  const w = 80, h = 60, img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { img[i * 4] = 200; img[i * 4 + 1] = 100; img[i * 4 + 2] = 50; img[i * 4 + 3] = i % w < 40 ? 255 : 0; }
  const mask = squareMask(w, h, 30, 20, 20);
  const out = inpaint(img, mask, w, h);
  assert.ok(out.every((v) => Number.isFinite(v)));
  assert.equal(out[(5 * w + 70) * 4 + 3], 0);
  assert.equal(out[(5 * w + 5) * 4 + 3], 255);
});

test('patch engine: continues stripes almost exactly and leaves far pixels untouched', () => {
  const truth = scene(W, H, { kind: 'stripes', grain: 0, seed: 11 });
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const out = inpaint(input, mask, W, H, { engine: 'patch' });
  const err = maeInMask(out, truth, mask);
  const smooth = maeInMask(inpaint(input, mask, W, H, { engine: 'smooth' }), truth, mask);
  console.log(`  stripes: patch ${err.toFixed(2)}, smooth ${smooth.toFixed(2)}`);
  assert.ok(err < 1.5, `patch error too high: ${err}`);
  assert.ok(err < smooth / 4, 'patch should be far better than the smooth fill on stripes');
  for (const i of farFromSquare(W, H, X0, Y0, S, 30)) {
    for (let c = 0; c < 4; c++) assert.equal(out[i * 4 + c], input[i * 4 + c]);
  }
});

test('patch engine: clearly beats the smooth fill on a textured photo', () => {
  const truth = scene(W, H, { grain: 4, seed: 11, kind: 'blobs' });
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const patch = maeInMask(inpaint(input, mask, W, H, { engine: 'patch' }), truth, mask);
  const smooth = maeInMask(inpaint(input, mask, W, H, { engine: 'smooth' }), truth, mask);
  console.log(`  blobs with grain: patch ${patch.toFixed(2)}, smooth ${smooth.toFixed(2)}`);
  assert.ok(patch < smooth * 0.7, `patch ${patch} vs smooth ${smooth}`);
});

test('patch engine: same input and seed give the same output; another seed gives a different fill', () => {
  const truth = scene(W, H, { grain: 4, seed: 3, kind: 'blobs' });
  const input = withObject(truth, W, H, X0, Y0, S);
  const mask = squareMask(W, H, X0, Y0, S);
  const a = inpaint(input, mask, W, H, { seed: 5 });
  const b = inpaint(input, mask, W, H, { seed: 5 });
  const c = inpaint(input, mask, W, H, { seed: 6 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('images too small for patches fall back to the smooth fill and stay finite', () => {
  const w = 8, h = 8, img = scene(w, h), mask = new Uint8Array(w * h);
  for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) mask[y * w + x] = 255;
  const out = inpaint(img, mask, w, h);
  assert.equal(out.length, w * h * 4);
  assert.ok(out.every((v) => Number.isFinite(v)));
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
});

test('a large photo with a large hole finishes in a few seconds', () => {
  const w = 2048, h = 1536, truth = scene(w, h, { grain: 4, kind: 'blobs' });
  const input = withObject(truth, w, h, 800, 600, 300);
  const mask = squareMask(w, h, 800, 600, 300);
  const t = performance.now();
  const out = inpaint(input, mask, w, h);
  const ms = performance.now() - t;
  console.log(`  2048x1536, 300px hole: ${ms.toFixed(0)} ms in Node`);
  assert.ok(ms < 8000, `too slow: ${ms}`);
  assert.ok(maeInMask(out, truth, mask) < 16);
});
