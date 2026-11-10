import { crc32 } from 'node:zlib';

/** PNG 文件签名和块类型，共享常量避免重复分配。 */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IDAT_TYPE = Buffer.from('IDAT', 'ascii');
const MAX_PNG_CHUNK_BYTES = 0x7fffffff;

/** 仅记录连续 IDAT 区间，避免大量微小块导致额外内存随块数增长。 */
interface IdatRange {
  start: number;
  end: number;
  count: number;
  dataLength: number;
}

/** 确认 PNG 块类型只含合法字母，避免将非法字节误识别为 IDAT。 */
function validateChunkType(input: Buffer, start: number): string {
  for (let index = start; index < start + 4; index++) {
    const value = input[index]!;
    if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) {
      throw new Error('PNG 块类型包含非法字符');
    }
  }
  return input.toString('ascii', start, start + 4);
}

/** 校验签名、块结构及 CRC，不解压 IDAT，也不改变任何原始块。 */
function parseIdatRange(input: Buffer): IdatRange {
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('PNG 签名无效');
  }
  const idats: IdatRange = { start: 0, end: 0, count: 0, dataLength: 0 };
  let offset = PNG_SIGNATURE.length;
  let idatEnded = false;
  let hasIend = false;
  let chunkCount = 0;
  while (offset < input.length) {
    if (input.length - offset < 12) throw new Error('PNG 块头或 CRC 不完整');
    const length = input.readUInt32BE(offset);
    if (length > MAX_PNG_CHUNK_BYTES || length > input.length - offset - 12) {
      throw new Error('PNG 块长度越界');
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    const type = validateChunkType(input, offset + 4);
    if (crc32(input.subarray(offset + 4, dataEnd)) !== input.readUInt32BE(dataEnd)) {
      throw new Error(`PNG ${type} 块 CRC 校验失败`);
    }
    if (chunkCount === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG 缺少有效的 IHDR');
      if (input.readUInt32BE(dataStart) === 0 || input.readUInt32BE(dataStart + 4) === 0) {
        throw new Error('PNG 图像尺寸无效');
      }
    }
    if (chunkCount > 0 && type === 'IHDR') throw new Error('PNG 包含重复的 IHDR');
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('暂不处理 APNG 动画');
    if (type === 'IDAT') {
      if (idatEnded) throw new Error('PNG IDAT 块不连续');
      if (idats.count === 0) idats.start = offset;
      idats.end = end;
      idats.count++;
      idats.dataLength += length;
    } else if (idats.count > 0) {
      idatEnded = true;
    }
    chunkCount++;
    offset = end;
    if (type === 'IEND') {
      if (length !== 0 || idats.count === 0) throw new Error('PNG IEND 或 IDAT 结构无效');
      if (offset !== input.length) throw new Error('PNG IEND 之后存在多余数据');
      hasIend = true;
      break;
    }
  }
  if (!hasIend) throw new Error('PNG 缺少完整的 IEND');
  return idats;
}

/** 合并连续 IDAT，保留压缩流与所有非 IDAT 块；无收益时返回原始字节。 */
export function optimizePngLossless(input: Buffer): Buffer {
  const range = parseIdatRange(input);
  if (range.count <= 1) return input;
  if (range.dataLength > MAX_PNG_CHUNK_BYTES) throw new Error('合并后的 PNG IDAT 块超过长度上限');
  const output = Buffer.allocUnsafe(input.length - (range.count - 1) * 12);
  input.copy(output, 0, 0, range.start);
  output.writeUInt32BE(range.dataLength, range.start);
  IDAT_TYPE.copy(output, range.start + 4);
  let position = range.start + 8;
  let checksum = crc32(IDAT_TYPE);
  for (let offset = range.start; offset < range.end;) {
    // 保留原始 zlib 数据流，只有块包装发生变化，不重新量化或重新压缩像素。
    const length = input.readUInt32BE(offset);
    const data = input.subarray(offset + 8, offset + 8 + length);
    data.copy(output, position);
    checksum = crc32(data, checksum);
    position += data.length;
    offset += length + 12;
  }
  output.writeUInt32BE(checksum, position);
  position += 4;
  input.copy(output, position, range.end);
  return output;
}
