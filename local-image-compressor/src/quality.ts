import type { QualityScore } from './types.js';

/** 在原分辨率上比较两份 RGBA 数据，仅记录黑白背景下的显示误差供诊断。 */
export function measureQuality(
  reference: Buffer,
  candidate: Buffer,
  width: number,
  height: number,
): QualityScore {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1
      || reference.length !== width * height * 4
      || candidate.length !== reference.length) {
    throw new Error('质量评估需要尺寸相同且完整的 RGBA 数据');
  }

  let totalBlack = 0;
  let totalWhite = 0;
  let worstBlockMse = 0;
  let maxAlphaError = 0;
  for (let top = 0; top < height; top += 16) {
    for (let left = 0; left < width; left += 16) {
      const bottom = Math.min(top + 16, height);
      const right = Math.min(left + 16, width);
      let black = 0;
      let white = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 4;
          const alphaA = reference[offset + 3]!;
          const alphaB = candidate[offset + 3]!;
          maxAlphaError = Math.max(maxAlphaError, Math.abs(alphaA - alphaB));
          for (let channel = 0; channel < 3; channel++) {
            // 合成后比较能忽略完全透明像素的隐藏 RGB，并暴露透明边缘的白边或黑边。
            const delta = (reference[offset + channel]! * alphaA
              - candidate[offset + channel]! * alphaB) / 255;
            black += delta * delta;
            const whiteDelta = delta + alphaB - alphaA;
            white += whiteDelta * whiteDelta;
          }
        }
      }
      const count = (bottom - top) * (right - left) * 3;
      worstBlockMse = Math.max(worstBlockMse, black / count, white / count);
      totalBlack += black;
      totalWhite += white;
    }
  }
  return {
    rmse: Math.sqrt(Math.max(totalBlack, totalWhite) / (width * height * 3)),
    worstBlockRmse: Math.sqrt(worstBlockMse),
    maxAlphaError,
  };
}

