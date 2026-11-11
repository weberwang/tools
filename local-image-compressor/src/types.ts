/** 首版仅处理静态、8 位的三种常用图片格式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** 全分辨率误差诊断结果，单位为 0～255 通道值，不参与候选筛选。 */
export interface QualityScore {
  rmse: number;
  worstBlockRmse: number;
  /** 最大 Alpha 误差，仅用于报告。 */
  maxAlphaError: number;
}

/** 单个编码候选的真实结果；体积无收益时不计算质量分数。 */
export interface CompressionAttempt {
  strategy: string;
  outputBytes: number;
  status: 'accepted' | 'rejected-size';
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

/** 对单张图片进行压缩时的资源限制。 */
export interface CompressionOptions {
  maxPixels?: number;
}
