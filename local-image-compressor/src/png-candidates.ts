import sharp from 'sharp';

/** 可独立编码的 PNG 候选；实际像素缓冲在编码时才生成。 */
export interface PngCandidate {
  name: string;
  encode: () => Promise<Buffer>;
}

/** 将 RGB 映射到指定有效精度，透明度始终保留原值。 */
function quantizeRgb(reference: Buffer, bits: number): Buffer {
  const pixels = Buffer.from(reference);
  const levels = (1 << bits) - 1;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const value = pixels[offset + channel]!;
      pixels[offset + channel] = Math.round(Math.round(value * levels / 255) * 255 / levels);
    }
  }
  return pixels;
}

/** 从同一份 sRGB RGBA 参考像素构造 PNG 候选，避免将一次有损结果继续量化。 */
export function createPngCandidates(
  reference: Buffer,
  width: number,
  height: number,
  hasAlpha: boolean,
): PngCandidate[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || reference.length !== width * height * 4) {
    throw new Error('PNG 候选需要尺寸相同且完整的 RGBA 参考像素');
  }
  const raw = { width, height, channels: 4 as const };

  /** 真彩色候选只在编码时分配量化缓冲，避免多个全分辨率副本同时常驻。 */
  async function encodeTruecolour(bits?: number): Promise<Buffer> {
    const pixels = bits === undefined ? reference : quantizeRgb(reference, bits);
    let image = sharp(pixels, { raw }).withIccProfile('srgb');
    // 原图没有透明通道时去掉填充的全不透明 Alpha，避免无谓地增加文件大小。
    if (!hasAlpha) image = image.removeAlpha();
    return image.png({ palette: false, compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  }

  return [
    ...[false, true].map((adaptiveFiltering): PngCandidate => ({
      name: adaptiveFiltering ? 'PNG 256 色感知量化（自适应滤波）' : 'PNG 256 色感知量化',
      encode: () => sharp(reference, { raw }).withIccProfile('srgb').png({
        palette: true, colours: 256, effort: 10, dither: 0,
        compressionLevel: 9, adaptiveFiltering,
      }).toBuffer(),
    })),
    { name: 'PNG 真彩色无损重编码', encode: () => encodeTruecolour() },
    ...[7, 6, 5].map((bits): PngCandidate => ({
      name: `PNG RGB ${bits} 位有效精度`,
      encode: () => encodeTruecolour(bits),
    })),
  ];
}
