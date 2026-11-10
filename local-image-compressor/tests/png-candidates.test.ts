import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { createPngCandidates, type PngCandidate } from '../src/png-candidates.js';

/** 构造覆盖 0～255 通道值和连续透明度的固定样本。 */
function pixels(transparent: boolean): Buffer {
  const result = Buffer.alloc(256 * 4);
  for (let x = 0; x < 256; x++) {
    const offset = x * 4;
    result[offset] = x;
    result[offset + 1] = 255 - x;
    result[offset + 2] = (x * 73) % 256;
    result[offset + 3] = transparent ? x : 255;
  }
  return result;
}

/** 按策略名称找到待验证的候选，缺失时明确报错。 */
function findCandidate(candidates: PngCandidate[], name: string): PngCandidate {
  const candidate = candidates.find(item => item.name === name);
  assert.ok(candidate, `缺少候选：${name}`);
  return candidate;
}

test('RGB 量化从原始像素独立生成，保护透明度并控制每通道误差', async () => {
  const reference = pixels(true);
  const snapshot = Buffer.from(reference);
  const candidates = createPngCandidates(reference, 256, 1, true);

  // 先执行低精度候选，再检查高精度候选，避免掩盖串联量化导致的精度损失。
  for (const [bits, maxError] of [[5, 4], [6, 2], [7, 1]] as const) {
    const data = await findCandidate(candidates, `PNG RGB ${bits} 位有效精度`).encode();
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 1);
    assert.equal(metadata.depth, 'uchar');
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.isPalette, false);
    assert.equal(data[24], 8);

    const decoded = await sharp(data).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    for (let offset = 0; offset < reference.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(decoded[offset + channel]! - reference[offset + channel]!) <= maxError);
      }
      assert.equal(decoded[offset + 3], reference[offset + 3]);
    }
    assert.deepEqual(reference, snapshot);
  }
});

test('全部 PNG 候选保持尺寸和原始输入缓冲区', async () => {
  const reference = pixels(true);
  const snapshot = Buffer.from(reference);
  const candidates = createPngCandidates(reference, 256, 1, true);
  assert.equal(candidates.length, 6);
  for (const candidate of candidates) {
    const data = await candidate.encode();
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 1);
    assert.ok(metadata.icc);
    assert.deepEqual(reference, snapshot);
  }
});

test('不透明输入的真彩色候选不添加多余 Alpha 通道', async () => {
  const candidates = createPngCandidates(pixels(false), 256, 1, false);
  for (const candidate of candidates.filter(item => item.name.includes('真彩色') || item.name.includes('RGB'))) {
    const metadata = await sharp(await candidate.encode()).metadata();
    assert.equal(metadata.hasAlpha, false);
    assert.equal(metadata.channels, 3);
  }
});

test('拒绝不完整的参考像素及无效尺寸', () => {
  assert.throws(() => createPngCandidates(Buffer.alloc(3), 1, 1, true), /RGBA/);
  assert.throws(() => createPngCandidates(Buffer.alloc(0), 0, 1, true), /RGBA/);
});
