import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

import { optimizePngLossless } from '../src/png-lossless.js';

/** 测试只需追踪块类型、数据和完整原字节，以检查元数据未被改动。 */
interface Chunk {
  type: string;
  data: Buffer;
  raw: Buffer;
}

/** 逐块解析测试生成的有效 PNG，便于构造不同的 IDAT 分块方式。 */
function chunksOf(input: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset);
    const end = offset + length + 12;
    chunks.push({
      type: input.toString('ascii', offset + 4, offset + 8),
      data: input.subarray(offset + 8, end - 4),
      raw: input.subarray(offset, end),
    });
    offset = end;
  }
  return chunks;
}

/** 创建携带正确 CRC 的块，避免测试被无效输入提前短路。 */
function makeChunk(type: string, data: Buffer): Buffer {
  const block = Buffer.alloc(data.length + 12);
  block.writeUInt32BE(data.length, 0);
  block.write(type, 4, 'ascii');
  data.copy(block, 8);
  block.writeUInt32BE(crc32(block.subarray(4, 8 + data.length)), 8 + data.length);
  return block;
}

/** 以一个额外 IDAT 包装拆分原压缩流，其他块逐字节保留。 */
function splitIdat(input: Buffer, middle?: Buffer): Buffer {
  const chunks = chunksOf(input);
  const idats = chunks.filter(chunk => chunk.type === 'IDAT');
  assert.equal(idats.length, 1);
  const payload = idats[0]!.data;
  assert.ok(payload.length > 2);
  const split = Math.floor(payload.length / 2);
  const parts = [input.subarray(0, 8)];
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      parts.push(makeChunk('IDAT', payload.subarray(0, split)));
      if (middle) parts.push(middle);
      parts.push(makeChunk('IDAT', payload.subarray(split)));
    } else parts.push(chunk.raw);
  }
  return Buffer.concat(parts);
}

/** 生成含透明度及色彩配置的图片，覆盖像素、ICC 和非 IDAT 块。 */
async function transparentFixture(): Promise<Buffer> {
  const pixels = Buffer.alloc(64 * 48 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const pixel = index / 4;
    pixels[index] = pixel % 256;
    pixels[index + 1] = (pixel >> 3) % 256;
    pixels[index + 2] = (pixel * 3) % 256;
    pixels[index + 3] = (pixel * 5) % 256;
  }
  return optimizePngLossless(await sharp(pixels, {
    raw: { width: 64, height: 48, channels: 4 },
  }).withIccProfile('srgb').png().toBuffer());
}

test('合并 IDAT 后透明像素、ICC 和其他块保持不变', async () => {
  const original = await transparentFixture();
  const split = splitIdat(original);
  const snapshot = Buffer.from(split);
  const output = optimizePngLossless(split);
  assert.equal(output.length, split.length - 12);
  assert.deepEqual(split, snapshot);
  assert.equal(chunksOf(output).filter(chunk => chunk.type === 'IDAT').length, 1);
  assert.deepEqual(chunksOf(output).filter(chunk => chunk.type !== 'IDAT').map(chunk => chunk.raw),
    chunksOf(split).filter(chunk => chunk.type !== 'IDAT').map(chunk => chunk.raw));
  const [sourceMetadata, outputMetadata, sourcePixels, outputPixels] = await Promise.all([
    sharp(split).metadata(), sharp(output).metadata(),
    sharp(split).ensureAlpha().raw().toBuffer(), sharp(output).ensureAlpha().raw().toBuffer(),
  ]);
  assert.ok(sourceMetadata.icc);
  assert.deepEqual(outputMetadata.icc, sourceMetadata.icc);
  assert.deepEqual(outputPixels, sourcePixels);
  assert.equal(outputMetadata.width, sourceMetadata.width);
  assert.equal(outputMetadata.height, sourceMetadata.height);
  assert.equal(outputMetadata.hasAlpha, sourceMetadata.hasAlpha);
});

test('即使收益不足 1%，仍可无损减少 PNG 的 IDAT 开销', async () => {
  const pixels = Buffer.alloc(128 * 128 * 3);
  let seed = 42;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const single = optimizePngLossless(await sharp(pixels, {
    raw: { width: 128, height: 128, channels: 3 },
  }).png({ compressionLevel: 0 }).toBuffer());
  const split = splitIdat(single);
  const output = optimizePngLossless(split);
  assert.ok((split.length - output.length) / split.length < 0.01);
  assert.equal(split.length - output.length, 12);
  assert.deepEqual(output, single);
});

test('单 IDAT 图片无需修改，保留全部原始字节', async () => {
  const original = await transparentFixture();
  assert.equal(chunksOf(original).filter(chunk => chunk.type === 'IDAT').length, 1);
  assert.deepEqual(optimizePngLossless(original), original);
});

test('大量连续空 IDAT 可合并且保留原图', async () => {
  const original = await transparentFixture();
  const empty = makeChunk('IDAT', Buffer.alloc(0));
  const parts: Buffer[] = [original.subarray(0, 8)];
  for (const chunk of chunksOf(original)) {
    if (chunk.type === 'IDAT') {
      for (let count = 0; count < 10000; count++) parts.push(empty);
    }
    parts.push(chunk.raw);
  }
  const fragmented = Buffer.concat(parts);
  const result = optimizePngLossless(fragmented);
  assert.equal(fragmented.length - result.length, 120000);
  assert.deepEqual(result, original);
});

test('损坏的 CRC、越界块和尾部数据被明确拒绝', async () => {
  const original = await transparentFixture();
  const corrupted = Buffer.from(original);
  const idatStart = original.indexOf(Buffer.from('IDAT'));
  assert.ok(idatStart > 0);
  corrupted[idatStart + 4] = corrupted[idatStart + 4]! ^ 1;
  assert.throws(() => optimizePngLossless(corrupted), /CRC/);
  assert.throws(() => optimizePngLossless(original.subarray(0, original.length - 3)), /不完整|越界/);
  assert.throws(() => optimizePngLossless(Buffer.concat([original, Buffer.from([0])])), /IEND/);
  assert.throws(() => optimizePngLossless(Buffer.from('invalid')), /签名/);
});

test('拒绝不连续的 IDAT 和动画控制块', async () => {
  const original = await transparentFixture();
  const separated = splitIdat(original, makeChunk('tEXt', Buffer.from('note\0value')));
  assert.throws(() => optimizePngLossless(separated), /不连续/);
  const withAnimation = splitIdat(original, makeChunk('acTL', Buffer.alloc(8)));
  assert.throws(() => optimizePngLossless(withAnimation), /动画/);
});
