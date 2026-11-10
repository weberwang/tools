import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { runBatch, type BatchItem, type BatchResult } from './batch.js';
/** 命令行默认值；与批处理 API 保持一致。 */
const DEFAULT_MAX_PIXELS = 16_000_000;

/** 可注入的终端输出，便于测试命令行错误和摘要。 */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** 解析后的命令行参数。 */
export interface CliOptions {
  inputPaths: string[];
  outputDir: string;
  recursive: boolean;
  reportPath?: string;
  maxPixels: number;
}

/** CLI 入口返回的进程退出码。 */
export type CliExitCode = 0 | 1 | 2;

/** 展示命令行用法与目录输出规则。 */
export const HELP_TEXT = `用法：npm run compress -- [选项] <文件或目录...>

选项：
  -o, --output <目录>       输出目录（默认：当前目录/compressed）
  -r, --recursive           递归处理目录中的图片
      --max-pixels <数量>   单张图片的像素上限（默认：16000000）
      --report <文件>       写出 JSON 报告；目标文件必须不存在
  -h, --help                显示帮助

支持扩展名：png、jpg、jpeg、webp。目录输入默认只处理当前层；使用 --recursive 才会进入子目录。
PNG 只使用固定 256 色感知量化方案，无需选择算法或质量档位。
质量门槛固定为整体 RMSE ≤ 4、最坏 16×16 区块 RMSE ≤ 12；有真实缩小才输出压缩结果。
体积或质量不达标时保留原图；JSON 报告的 attempts 记录编码体积、质量和拒绝原因。
单个目录的图片保持相对目录结构；多个目录输入时，会在相对路径前加各目录的 basename，仍冲突时该项会报错。
输出不会覆盖已有文件或源图；输出目录是输入目录的子目录时会排除整个输出子树。
`;

/** 返回默认的终端输出实现。 */
function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/** 把 parseArgs 返回的值校验为普通字符串。 */
function optionString(value: string | boolean | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} 必须提供非空值`);
  }
  return value;
}

/** 校验正整数命令行参数，拒绝小数、符号和超出安全整数的值。 */
function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数且不能超过安全整数范围`);
  }
  return parsed;
}

/** 使用 node:util.parseArgs 解析并校验 CLI 参数。 */
export function parseCliArgs(argv: string[], cwd = process.cwd()): CliOptions | 'help' {
  const parsed = parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      recursive: { type: 'boolean', short: 'r' },
      help: { type: 'boolean', short: 'h' },
      report: { type: 'string' },
      'max-pixels': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.values.help === true) return 'help';
  if (parsed.positionals.length === 0) {
    throw new Error('至少需要一个输入文件或目录；使用 --help 查看用法');
  }

  const output = optionString(parsed.values.output, '--output') ?? resolve(cwd, 'compressed');
  const report = optionString(parsed.values.report, '--report');
  const maxPixelsValue = optionString(parsed.values['max-pixels'], '--max-pixels');
  const maxPixels = maxPixelsValue === undefined
    ? DEFAULT_MAX_PIXELS
    : positiveInteger(maxPixelsValue, '--max-pixels');

  return {
    inputPaths: parsed.positionals,
    outputDir: output,
    recursive: parsed.values.recursive === true,
    reportPath: report,
    maxPixels,
  };
}

/** 将字节数转换为简洁的终端显示值。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** 输出一项图片结果，失败信息保持简短但包含源路径。 */
function printItem(item: BatchItem, io: CliIO): void {
  if (item.status === 'failed') {
    io.stderr(`失败：${item.inputPath}：${item.error ?? '未知错误'}\n`);
    return;
  }
  if (item.status === 'skipped') return;
  const status = item.status === 'compressed' ? '压缩' : '保留';
  const inputBytes = item.inputBytes === undefined ? '?' : formatBytes(item.inputBytes);
  const outputBytes = item.outputBytes === undefined ? '?' : formatBytes(item.outputBytes);
  const strategy = item.strategy === undefined ? '' : `，策略：${item.strategy}`;
  io.stdout(`${status}：${item.inputPath} -> ${item.outputPath ?? '?'}（${inputBytes} -> ${outputBytes}${strategy}）\n`);
}

/** 输出批处理总计与报告位置。 */
function printSummary(result: BatchResult, io: CliIO): void {
  const { summary } = result;
  io.stdout(
    `完成：成功 ${summary.compressed + summary.kept}（压缩 ${summary.compressed}，保留 ${summary.kept}），` +
    `失败 ${summary.failed}，跳过 ${summary.skipped}；` +
    `${formatBytes(summary.inputBytes)} -> ${formatBytes(summary.outputBytes)}，` +
    `节省 ${summary.inputBytes === 0
      ? '0.0'
      : ((1 - summary.outputBytes / summary.inputBytes) * 100).toFixed(1)}%\n`,
  );
  if (result.reportPath !== undefined && result.reportError === undefined) {
    io.stdout(`报告：${result.reportPath}\n`);
  }
  if (result.reportError !== undefined) {
    io.stderr(`报告写入失败：${result.reportError}\n`);
  }
}

/** 执行一次命令行批处理；异常转换为可供 bin 使用的退出码。 */
export async function main(argv = process.argv.slice(2), io = defaultIO()): Promise<CliExitCode> {
  let parsed: CliOptions | 'help';
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`错误：${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr(HELP_TEXT);
    return 2;
  }
  if (parsed === 'help') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  let result: BatchResult;
  try {
    io.stdout(`开始处理 ${parsed.inputPaths.length} 个输入...\n`);
    result = await runBatch(parsed);
  } catch (error) {
    io.stderr(`错误：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const item of result.files) printItem(item, io);
  printSummary(result, io);
  return result.summary.failed === 0 && result.reportError === undefined ? 0 : 1;
}

/** 仅在直接执行 src/cli.ts 时启动命令行，避免测试导入时产生副作用。 */
async function runAsScript(): Promise<void> {
  const current = resolve(fileURLToPath(import.meta.url));
  const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
  if (current !== invoked) return;
  process.exitCode = await main();
}

void runAsScript();
