import sharp, { type Sharp } from 'sharp';
import { isAcceptable, measureQuality } from './quality.js';
import type {
  CompressionOptions, CompressionResult, ImageFormat, QualityScore,
} from './types.js';

/** 每个候选由格式专用编码器产生，统一使用解码后的像素进行验收。 */
interface Candidate {
  name: string;
  encode: (pipeline: Sharp) => Sharp;
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

/** 枚举有限候选，避免假设编码质量与视觉误差严格单调而遗漏合格结果。 */
function candidatesFor(format: ImageFormat): Candidate[] {
  if (format === 'png') {
    return [
      {
        name: 'PNG 真彩色重新编码',
        encode: (image) => image.png({ compressionLevel: 9, adaptiveFiltering: true }),
      },
      ...[256, 128, 64, 32].map((colours): Candidate => ({
        name: `PNG ${colours} 色量化`,
        encode: (image) => image.png({
          palette: true, colours, effort: 7, dither: 1,
          compressionLevel: 9, adaptiveFiltering: true,
        }),
      })),
    ];
  }
  if (format === 'jpeg') {
    return [95, 90, 85, 80, 70, 60, 50].flatMap((quality) =>
      (['4:4:4', '4:2:0'] as const).map((chromaSubsampling): Candidate => ({
        name: `JPEG Q${quality} ${chromaSubsampling}`,
        encode: (image) => image.removeAlpha().jpeg({
          quality, chromaSubsampling, mozjpeg: true,
        }),
      })));
  }
  return [
    {
      name: 'WebP 无损重新编码',
      encode: (image) => image.webp({ lossless: true, effort: 5 }),
    },
    ...[95, 90, 85, 80, 70, 60, 50].map((quality): Candidate => ({
      name: `WebP Q${quality}`,
      encode: (image) => image.webp({ quality, alphaQuality: 100, effort: 5 }),
    })),
  ];
}

/** 同格式压缩静态图片，候选必须满足质量阈值且至少节省 1%，否则返回原始字节。 */
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
  const raw = { width: info.width, height: info.height, channels: 4 as const };
  let best = input;
  let strategy = '保留原文件：未找到至少节省 1% 且符合质量阈值的候选';
  let bestScore: QualityScore = { rmse: 0, worstBlockRmse: 0, maxAlphaError: 0 };
  for (const candidate of candidatesFor(format)) {
    // 编码新文件不继承 EXIF/GPS/XMP；嵌入标准 sRGB 描述，保证色彩解释明确。
    const data = await candidate.encode(sharp(reference, { raw }).withIccProfile('srgb'))
      .toBuffer();
    if (data.length >= best.length || data.length > input.length * 0.99) continue;
    const decoded = await sharp(data, settings)
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== info.width || decoded.info.height !== info.height) {
      throw new Error('编码后的图片尺寸发生意外变化');
    }
    const score = measureQuality(reference, decoded.data, info.width, info.height);
    if (isAcceptable(score, preset)) {
      best = data;
      bestScore = score;
      strategy = candidate.name;
    }
  }
  return {
    data: best, format, strategy,
    status: best === input ? 'kept' : 'compressed',
    inputBytes: input.length, outputBytes: best.length, score: bestScore,
  };
}
