/** 支持的三档质量策略；档位越保守，允许的像素误差越小。 */
export type Preset = 'gentle' | 'balanced' | 'small';

/** 首版仅处理静态、8 位的三种常用图片格式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** 全分辨率校验结果，误差单位为 0～255 通道值。 */
export interface QualityScore {
  rmse: number;
  worstBlockRmse: number;
  /** 最大 Alpha 误差仅用于报告，质量判定以黑白背景合成误差为准。 */
  maxAlphaError: number;
}

/** 单个编码候选的真实结果；体积无收益时不计算质量分数。 */
export interface CompressionAttempt {
  strategy: string;
  outputBytes: number;
  status: 'accepted' | 'rejected-size' | 'rejected-quality';
  score?: QualityScore;
  rejectionReason?: string;
}

/** 压缩引擎返回完整文件；保留原始字节时不会清除原元数据。 */
export interface CompressionResult {
  data: Buffer;
  format: ImageFormat;
  strategy: string;
  status: 'compressed' | 'kept';
  inputBytes: number;
  outputBytes: number;
  score: QualityScore;
  attempts: CompressionAttempt[];
}

/** 对单张图片进行压缩时的质量与资源限制。 */
export interface CompressionOptions {
  preset?: Preset;
  maxPixels?: number;
}
