import sharp from 'sharp';
import { createPngCandidates } from './png-candidates.js';
import { optimizePngLossless } from './png-lossless.js';
import { isAcceptable, measureQuality } from './quality.js';
import type {
  CompressionAttempt, CompressionOptions, CompressionResult, ImageFormat, QualityScore,
} from './types.js';

/** 每个候选由格式专用编码器产生，统一使用解码后的像素进行验收。 */
interface Candidate {
  name: string;
  encode: () => Promise<Buffer>;
}

/** 所有有损候选共享同一份参考像素，原始字节只供无损容器优化使用。 */
interface EncodingContext {
  input: Buffer;
  reference: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** 读取 PNG 块而非搜索字符串，避免把图像数据中的 acTL 误判为动画。 */
function isAnimatedPng(input: Buffer): boolean {
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (length > input.length - offset - 12) {
      throw new Error('PNG 数据块不完整');
    }
    const kind = input.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL') return true;
    if (kind === 'IEND') return false;
    offset += length + 12;
  }
  return false;
}

/** 按格式生成独立候选，覆盖调色板、真彩色量化和原始 PNG 的无损整理。 */
function candidatesFor(format: ImageFormat, context: EncodingContext): Candidate[] {
  const { input, reference, width, height, hasAlpha } = context;
  /** 重建编码管线，避免某个候选的变更影响其他候选。 */
  const image = () => sharp(reference, { raw: { width, height, channels: 4 } }).withIccProfile('srgb');
  if (format === 'png') {
    return [
      { name: 'PNG IDAT 无损优化', encode: async () => optimizePngLossless(input) },
      ...createPngCandidates(reference, width, height, hasAlpha),
    ];
  }
  if (format === 'jpeg') {
    return [95, 90, 85, 80, 70, 60, 50].flatMap((quality) =>
      (['4:4:4', '4:2:0'] as const).map((chromaSubsampling): Candidate => ({
        name: `JPEG Q${quality} ${chromaSubsampling}`,
        encode: () => image().removeAlpha().jpeg({
          quality, chromaSubsampling, mozjpeg: true,
        }).toBuffer(),
      })));
  }
  return [
    {
      name: 'WebP 无损重新编码',
      encode: () => image().webp({ lossless: true, effort: 5 }).toBuffer(),
    },
    ...[95, 90, 85, 80, 70, 60, 50].map((quality): Candidate => ({
      name: `WebP Q${quality}`,
      encode: () => image().webp({ quality, alphaQuality: 100, effort: 5 }).toBuffer(),
    })),
  ];
}

/** 同格式压缩静态图片，返回满足质量门槛且严格更小的最优结果。 */
export async function compressImage(
  input: Buffer,
  options: CompressionOptions = {},
): Promise<CompressionResult> {
  const preset = options.preset ?? 'balanced';
  const maxPixels = options.maxPixels ?? 16_000_000;
  if (!['gentle', 'balanced', 'small'].includes(preset)) {
    throw new Error('未知质量档位');
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new Error('像素上限必须是正整数');
  }
  if (input.length > 128 * 1024 * 1024) throw new Error('图片超过 128 MiB 文件上限');
  if (input.length === 0) throw new Error('图片文件为空');
  const settings = { limitInputPixels: maxPixels, failOn: 'warning' as const };
  const metadata = await sharp(input, settings).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format)) {
    throw new Error(`暂不支持 ${metadata.format} 格式，仅支持 PNG、JPEG、WebP`);
  }
  const format = metadata.format as ImageFormat;
  if ((metadata.pages ?? 1) > 1 || (format === 'png' && isAnimatedPng(input))) {
    throw new Error('暂不处理动画或多页图片，避免丢失帧');
  }
  if (metadata.depth !== 'uchar'
      || (format === 'png' && input[24]! > 8)) {
    throw new Error('暂不处理高于 8 位的图片，避免降低位深');
  }

  // 先完成 EXIF 方向校正和色彩转换，再从同一份像素编码所有候选，避免重复有损压缩。
  const { data: reference, info } = await sharp(input, settings)
    .autoOrient().toColourspace('srgb').ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let best = input;
  let strategy = '';
  let bestScore: QualityScore = { rmse: 0, worstBlockRmse: 0, maxAlphaError: 0 };
  const attempts: CompressionAttempt[] = [];
  for (const candidate of candidatesFor(format, { input, reference,
    width: info.width, height: info.height, hasAlpha: metadata.hasAlpha ?? false })) {
    const data = await candidate.encode();
    // 不再因为收益不足 1% 丢弃真实优化；已达极限时也不能输出更大的文件。
    if (data.length >= input.length) {
      attempts.push({ strategy: candidate.name, outputBytes: data.length, status: 'rejected-size',
        rejectionReason: '候选没有比原文件更小，未继续质量评估' });
      continue;
    }
    const decoded = await sharp(data, settings)
      // IDAT 整理保留原 EXIF 方向，其解码方向必须与参考像素一致。
      .autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== info.width || decoded.info.height !== info.height) {
      throw new Error('编码后的图片尺寸发生意外变化');
    }
    const score = measureQuality(reference, decoded.data, info.width, info.height);
    if (!isAcceptable(score, preset)) {
      attempts.push({ strategy: candidate.name, outputBytes: data.length, score, status: 'rejected-quality',
        rejectionReason: '整体或局部合成误差超过当前档位上限' });
      continue;
    }
    attempts.push({ strategy: candidate.name, outputBytes: data.length, score, status: 'accepted' });
    if (data.length < best.length) {
      best = data;
      bestScore = score;
      strategy = candidate.name;
    }
  }
  if (best === input) {
    strategy = attempts.some(attempt => attempt.status === 'rejected-quality')
      ? '保留原文件：更小候选均未通过质量门槛，详见 attempts'
      : '保留原文件：所有候选均未缩小文件，详见 attempts';
  }
  return {
    data: best, format, strategy,
    status: best === input ? 'kept' : 'compressed',
    inputBytes: input.length, outputBytes: best.length, score: bestScore, attempts,
  };
}
