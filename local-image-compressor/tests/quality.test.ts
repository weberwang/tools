import assert from 'node:assert/strict';
import test from 'node:test';
import { isAcceptable, measureQuality } from '../src/quality.js';

/** 生成用于误差边界验证的纯色 RGBA 像素。 */
function solid(width: number, height: number, value: number, alpha = 255): Buffer {
  const data = Buffer.alloc(width * height * 4, value);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return data;
}

test('完全相同的像素误差为零，包括不足 16 像素的边缘块', () => {
  const data = solid(17, 19, 30);
  assert.deepEqual(measureQuality(data, data, 17, 19), {
    rmse: 0, worstBlockRmse: 0, maxAlphaError: 0,
  });
});

test('完全透明的隐藏 RGB 不影响观感分数', () => {
  const score = measureQuality(solid(2, 2, 0, 0), solid(2, 2, 255, 0), 2, 2);
  assert.equal(score.rmse, 0);
});

test('黑色透明边缘的变化能在白背景上被发现', () => {
  const score = measureQuality(solid(2, 2, 0, 0), solid(2, 2, 0, 255), 2, 2);
  assert.equal(score.rmse, 255);
  assert.equal(score.maxAlphaError, 255);
  assert.equal(isAcceptable(score), false);
});

test('稀少的 Alpha 极值只作诊断，合成误差达标即可通过', () => {
  const original = solid(64, 64, 0);
  const modified = Buffer.from(original);
  modified[3] = 187;
  const score = measureQuality(original, modified, 64, 64);
  assert.equal(score.maxAlphaError, 68);
  assert.ok(score.rmse < 4);
  assert.ok(score.worstBlockRmse < 12);
  assert.equal(isAcceptable(score), true);
});

test('局部透明度损伤仍会被合成后的区块误差拒绝', () => {
  const original = solid(256, 256, 0);
  const modified = Buffer.from(original);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) modified[(y * 256 + x) * 4 + 3] = 215;
  }
  const score = measureQuality(original, modified, 256, 256);
  assert.ok(score.rmse < 4);
  assert.equal(score.worstBlockRmse, 40);
  assert.equal(isAcceptable(score), false);
});

test('很小的局部缺陷不能被低整体误差掩盖', () => {
  const original = solid(256, 256, 0);
  const modified = Buffer.from(original);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const offset = (y * 256 + x) * 4;
      modified.fill(40, offset, offset + 3);
    }
  }
  const score = measureQuality(original, modified, 256, 256);
  assert.ok(score.rmse < 4);
  assert.equal(score.worstBlockRmse, 40);
  assert.equal(isAcceptable(score), false);
});

test('错误像素长度被拒绝', () => {
  assert.throws(() => measureQuality(Buffer.alloc(3), Buffer.alloc(3), 1, 1));
});
