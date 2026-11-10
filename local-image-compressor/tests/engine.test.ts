import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { compressImage } from '../src/engine.js';
import { isAcceptable, measureQuality } from '../src/quality.js';

/** 固定渐变和透明边缘，避免随机样本让测试结果漂移。 */
function fixture(width = 128, height = 96, transparent = false): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(x * 255 / (width - 1));
      data[offset + 1] = Math.round(y * 255 / (height - 1));
      data[offset + 2] = (x + y) % 256;
      data[offset + 3] = transparent ? Math.round(x * 255 / (width - 1)) : 255;
    }
  }
  return data;
}

/** 固定少量主色与细小噪声，可选连续透明度以覆盖调色板的 Alpha 量化。 */
function paletteFixture(transparent = false): Buffer {
  const pixels = Buffer.alloc(128 * 128 * 4);
  let seed = 42;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const color = (seed >>> 24) % 8;
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[offset + channel] = 32 + ((color >> channel) & 1) * 160 + (seed >>> 24) % 5;
    }
    if (transparent) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[offset + 3] = transparent ? seed >>> 24 : 255;
  }
  return pixels;
}

/** 构造合法 PNG 块，复用于 IDAT 分块和 APNG 信号的边界用例。 */
function pngChunk(kind: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(kind, 4, 'ascii');
  payload.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** 只改变压缩流的分块方式，制造小于 1% 的可消除容器开销。 */
function splitIdat(input: Buffer): Buffer {
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (input.toString('ascii', offset + 4, offset + 8) === 'IDAT' && length > 1) {
      const payload = input.subarray(offset + 8, offset + 8 + length);
      const middle = Math.floor(length / 2);
      return Buffer.concat([input.subarray(0, offset), pngChunk('IDAT', payload.subarray(0, middle)),
        pngChunk('IDAT', payload.subarray(middle)), input.subarray(offset + length + 12)]);
    }
    offset += length + 12;
  }
  throw new Error('测试 PNG 缺少可分割的 IDAT');
}

/** 将输出与原文件按相同显示方向及色彩空间解码，独立复核误差。 */
async function verifyResult(original: Buffer, output: Buffer): Promise<void> {
  const reference = await sharp(original).autoOrient().toColourspace('srgb')
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = await sharp(output).autoOrient().toColourspace('srgb')
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, reference.info.width);
  assert.equal(result.info.height, reference.info.height);
  const score = measureQuality(reference.data, result.data,
    reference.info.width, reference.info.height);
  assert.ok(isAcceptable(score, 'balanced'), JSON.stringify(score));
}

test('透明 PNG 明显缩小，透明边缘和原图字节均受保护', async () => {
  const original = await sharp(fixture(128, 96, true), {
    raw: { width: 128, height: 96, channels: 4 },
  }).png({ compressionLevel: 0 }).toBuffer();
  const snapshot = Buffer.from(original);
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  assert.ok(result.outputBytes < result.inputBytes * 0.9);
  assert.equal((await sharp(result.data).metadata()).hasAlpha, true);
  assert.deepEqual(original, snapshot);
  await verifyResult(original, result.data);
});

test('颜色接近但分布复杂的 PNG 实际选择调色板量化', async () => {
  const original = await sharp(paletteFixture(), {
    raw: { width: 128, height: 128, channels: 4 },
  }).png({ compressionLevel: 9 }).toBuffer();
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  assert.match(result.strategy, /量化/);
  assert.equal((await sharp(result.data).metadata()).isPalette, true);
  assert.ok(result.outputBytes < original.length * 0.8);
  await verifyResult(original, result.data);
});

test('透明调色板按合成误差验收，不因 Alpha 极值误差回退', async () => {
  const original = await sharp(paletteFixture(true), {
    raw: { width: 128, height: 128, channels: 4 },
  }).png({ compressionLevel: 0 }).toBuffer();
  const snapshot = Buffer.from(original);
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  assert.equal((await sharp(result.data).metadata()).isPalette, true);
  assert.equal((await sharp(result.data).metadata()).hasAlpha, true);
  assert.ok(result.score.maxAlphaError > 6);
  assert.ok(result.outputBytes < original.length * 0.5);
  assert.deepEqual(original, snapshot);
  await verifyResult(original, result.data);
});

test('高彩噪声 PNG 使用 RGB 候选压缩并记录被拒的调色板误差', async () => {
  const pixels = Buffer.alloc(128 * 128 * 4);
  let seed = 42;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[offset + channel] = seed >>> 24;
    }
    pixels[offset + 3] = 255;
  }
  const original = await sharp(pixels, {
    raw: { width: 128, height: 128, channels: 4 },
  }).png({ compressionLevel: 0 }).toBuffer();
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  assert.match(result.strategy, /RGB/);
  assert.equal(result.score.maxAlphaError, 0);
  assert.ok(result.attempts.some(attempt => attempt.status === 'rejected-quality' && attempt.score));
  assert.ok(result.attempts.some(attempt => attempt.status === 'accepted' && /RGB/.test(attempt.strategy)));
  assert.ok(result.outputBytes < original.length);
  await verifyResult(original, result.data);
});

test('不足百分之一的无损容器优化仍作为合格候选参与择优', async () => {
  const input = await sharp(fixture(128, 128, true), {
    raw: { width: 128, height: 128, channels: 4 },
  }).png({ compressionLevel: 0 }).toBuffer();
  const original = splitIdat(input);
  const result = await compressImage(original);
  const lossless = result.attempts.find(attempt => /IDAT/.test(attempt.strategy));
  assert.ok(lossless);
  assert.equal(lossless.status, 'accepted');
  assert.ok(lossless.outputBytes < original.length);
  assert.ok(lossless.outputBytes > original.length * 0.99);
  assert.equal(lossless.score?.rmse, 0);
  assert.equal(lossless.score?.maxAlphaError, 0);
  assert.ok(result.outputBytes <= lossless.outputBytes);
});

test('带 EXIF 方向的 PNG 选中 IDAT 优化时按显示方向评估像素', async () => {
  const png = await sharp(fixture(2, 3), {
    raw: { width: 2, height: 3, channels: 4 },
  }).png().toBuffer();
  // 最小 TIFF 只记录旋转方向、不嵌入 ICC，让保留元数据的无损候选确实更小。
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  const oriented = Buffer.concat([png.subarray(0, 33), pngChunk('eXIf', tiff), png.subarray(33)]);
  const original = splitIdat(oriented);
  assert.equal((await sharp(original).metadata()).orientation, 6);
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  assert.match(result.strategy, /IDAT/);
  assert.equal((await sharp(result.data).metadata()).orientation, 6);
  assert.equal(result.score.rmse, 0);
  await verifyResult(original, result.data);
});

test('JPEG 自动选参、校正方向并清除 EXIF/GPS', async () => {
  const original = await sharp(fixture(), {
    raw: { width: 128, height: 96, channels: 4 },
  }).withExif({ IFD0: { ImageDescription: '测试'.repeat(3000) } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  assert.equal((await sharp(original).metadata()).orientation, 6);
  const result = await compressImage(original);
  assert.equal(result.status, 'compressed');
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 96);
  assert.equal(metadata.height, 128);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.ok(metadata.icc);
  await verifyResult(original, result.data);
});

test('WebP 保持格式且不会输出比原图更大的文件', async () => {
  const original = await sharp(fixture(), {
    raw: { width: 128, height: 96, channels: 4 },
  }).webp({ lossless: true }).toBuffer();
  const result = await compressImage(original);
  assert.equal(result.format, 'webp');
  assert.ok(result.outputBytes <= result.inputBytes);
  await verifyResult(original, result.data);
});

test('微小且已优化的图片保留原始字节', async () => {
  const original = await sharp({ create: {
    width: 1, height: 1, channels: 3, background: '#fff',
  } }).png().toBuffer();
  const result = await compressImage(original);
  assert.equal(result.status, 'kept');
  assert.deepEqual(result.data, original);
  assert.ok(result.attempts.length > 0);
  assert.ok(result.attempts.every(attempt => attempt.status !== 'accepted'));
  assert.ok(result.attempts.every(attempt => attempt.rejectionReason));
});

test('拒绝损坏数据、空文件及超过像素上限的图片', async () => {
  await assert.rejects(compressImage(Buffer.from('not an image')));
  await assert.rejects(compressImage(Buffer.alloc(0)), /为空/);
  const original = await sharp({ create: {
    width: 10, height: 10, channels: 3, background: '#fff',
  } }).png().toBuffer();
  await assert.rejects(compressImage(original, { maxPixels: 99 }));
});

test('16 位 PNG 被明确拒绝，不会静默降位深', async () => {
  const original = await sharp({ create: {
    width: 16, height: 16, channels: 3, background: '#abc',
  } }).toColourspace('rgb16').png().toBuffer();
  assert.equal(original[24], 16);
  await assert.rejects(compressImage(original), /位/);
});

test('真实双帧 WebP 被拒绝，避免仅保存第一帧', async () => {
  const original = await sharp(fixture(16, 32), {
    raw: { width: 16, height: 32, channels: 4, pageHeight: 16 },
  }).webp({ lossless: true, loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(original).metadata()).pages, 2);
  await assert.rejects(compressImage(original), /动画/);
});

test('APNG 动画控制块被拒绝，即使解码器仅报告静态 PNG', async () => {
  const original = await sharp({ create: {
    width: 16, height: 16, channels: 3, background: '#abc',
  } }).png().toBuffer();
  // 此控制块模拟 APNG 信号；CRC 使用标准算法，避免验证被损坏块错误提前短路。
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(2, 0);
  const control = pngChunk('acTL', payload);
  const animated = Buffer.concat([original.subarray(0, 33), control, original.subarray(33)]);
  await assert.rejects(compressImage(animated), /动画/);
});
