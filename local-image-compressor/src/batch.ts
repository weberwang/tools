import { randomBytes } from 'node:crypto';
import { opendir, lstat, mkdir, open, readFile, unlink, link } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';

import { compressImage } from './engine.js';
import { assertNoSymlinkComponents, assertSourceUnchanged, currentFileSize, replaceInPlace } from './file-in-place.js';
import type { CompressionAttempt, CompressionResult, ImageFormat, QualityScore } from './types.js';

/** 默认的输出目录名称。 */
export const DEFAULT_OUTPUT_DIRECTORY = 'compressed';

/** 默认的像素上限，用来避免意外处理超大图片。 */
export const DEFAULT_MAX_PIXELS = 16_000_000;

/** 单文件读取上限；顺序处理仍然需要防止一次读入过大的文件。 */
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** 单个图片的处理结果，既用于终端摘要，也用于 JSON 报告。 */
export interface BatchItem {
  status: 'compressed' | 'kept' | 'failed' | 'skipped';
  inputPath: string;
  outputPath?: string;
  format?: ImageFormat;
  inputBytes?: number;
  outputBytes?: number;
  strategy?: string;
  score?: QualityScore;
  attempts?: CompressionAttempt[];
  error?: string;
}

/** 批处理总计；原地模式另计失败源图的已知大小及无法确认大小的项数。 */
export interface BatchSummary {
  total: number;
  compressed: number;
  kept: number;
  failed: number;
  skipped: number;
  inputBytes: number;
  outputBytes: number;
  /** 无法获知原始或当前大小的失败项数，仅用于原地模式。 */
  unknownInputSize: number;
  unknownOutputSize: number;
}

/** 批处理报告的稳定 JSON 结构。 */
export interface BatchReport {
  version: 1;
  generatedAt: string;
  options: {
    inputPaths: string[];
    outputDir?: string;
    inPlace: boolean;
    recursive: boolean;
    maxPixels: number;
  };
  summary: BatchSummary;
  files: BatchItem[];
}

/** 批处理入口参数。cwd 主要用于测试，也让调用者可以明确解释相对路径。 */
export interface BatchOptions {
  inputPaths: string[];
  outputDir?: string;
  inPlace?: boolean;
  recursive?: boolean;
  maxPixels?: number;
  reportPath?: string;
  cwd?: string;
}

/** 批处理返回值；reportError 表示图片已处理但报告发布失败。 */
export interface BatchResult {
  summary: BatchSummary;
  files: BatchItem[];
  report: BatchReport;
  reportPath?: string;
  reportError?: string;
}

/** 表示用户输入的一个文件或目录根。 */
interface InputRoot {
  path: string;
  kind: 'file' | 'directory';
}

/** 表示已经发现、等待顺序处理的图片。 */
interface InputFile {
  path: string;
  relativePath: string;
}

/** 表示发现阶段的失败或跳过计数。 */
interface DiscoveryResult {
  roots: InputRoot[];
  files: InputFile[];
  items: BatchItem[];
  skipped: number;
}

/** 用于区分没有可处理图片与其他批处理错误。 */
export class EmptyInputError extends Error {
  /** 创建空输入错误。 */
  public constructor(message = '没有找到可处理的图片文件') {
    super(message);
    this.name = 'EmptyInputError';
  }
}

/** 表示输出位置会覆盖输入目录或落在不安全的路径上。 */
export class UnsafeOutputError extends Error {
  /** 创建不安全输出路径错误。 */
  public constructor(message: string) {
    super(message);
    this.name = 'UnsafeOutputError';
  }
}

/** 表示批处理参数或文件系统状态不满足要求。 */
export class BatchInputError extends Error {
  /** 创建批处理输入错误。 */
  public constructor(message: string) {
    super(message);
    this.name = 'BatchInputError';
  }
}

/** 判断未知异常是否带有 Node 文件系统错误码。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** 把路径转为当前工作目录下的绝对路径。 */
function absolutePath(value: string, cwd: string): string {
  return resolve(cwd, value);
}

/** 在 Windows 上使用不区分大小写的键，避免同一路径被当成两项。 */
function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 判断 child 是否位于 parent 内部，默认不把 parent 自身算作内部。 */
function isPathInside(child: string, parent: string, includeEqual = false): boolean {
  const childValue = pathKey(child);
  const parentValue = pathKey(parent);
  const childForRelative = process.platform === 'win32' ? childValue : child;
  const parentForRelative = process.platform === 'win32' ? parentValue : parent;
  const relation = relative(parentForRelative, childForRelative);
  if (relation === '') {
    return includeEqual;
  }
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !parse(relation).root;
}

/** 判断两个路径是否相同。 */
function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

/** 将扩展名映射到引擎返回的格式名称。 */
function formatForExtension(filePath: string): ImageFormat | undefined {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.png') return 'png';
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.webp') return 'webp';
  return undefined;
}

/** 判断目录遍历时是否应跳过某个路径。 */
function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** 返回简洁、可展示的异常信息。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** 确认输出目录存在时确实是目录，并拒绝通过链接写入其他位置。 */
async function validateOutputDirectory(outputDir: string): Promise<void> {
  await assertNoSymlinkComponents(outputDir);
  try {
    const stats = await lstat(outputDir);
    if (!stats.isDirectory()) {
      throw new UnsafeOutputError(`输出路径不是目录：${outputDir}`);
    }
  } catch (error) {
    if (error instanceof UnsafeOutputError) throw error;
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

/** 校验输出目录相对所有目录输入根的位置关系。 */
function validateOutputRelation(outputDir: string, roots: InputRoot[]): void {
  for (const root of roots) {
    if (root.kind !== 'directory') continue;
    if (samePath(outputDir, root.path)) {
      throw new UnsafeOutputError(`输出目录不能等于输入目录：${outputDir}`);
    }
    if (isPathInside(outputDir, root.path)) {
      // 输出是输入目录的子目录可以使用，但遍历时会排除整个输出子树。
      continue;
    }
    if (isPathInside(root.path, outputDir)) {
      throw new UnsafeOutputError(`输出目录不能包含输入目录，否则可能覆盖源图：${outputDir}`);
    }
  }
}

/** 记录一个发现阶段错误，同时保留后续输入继续处理的机会。 */
function addDiscoveryFailure(
  items: BatchItem[],
  inputPath: string,
  error: unknown,
  outputPath?: string,
): void {
  items.push({
    status: 'failed',
    inputPath,
    ...(outputPath === undefined ? {} : { outputPath }),
    error: errorMessage(error),
  });
}

/** 递归或非递归收集一个目录下的受支持图片。 */
async function collectDirectory(
  root: string,
  outputDir: string | undefined,
  recursive: boolean,
  files: InputFile[],
  seenFiles: Set<string>,
  items: BatchItem[],
): Promise<number> {
  let skipped = 0;

  /** 遍历当前目录；目录句柄异常只影响当前根，不中断其他输入。 */
  async function visit(directory: string): Promise<void> {
    let handle: AsyncIterable<Dirent> & { close?: () => Promise<void> };
    try {
      handle = await opendir(directory);
    } catch (error) {
      addDiscoveryFailure(items, directory, `无法读取目录：${errorMessage(error)}`);
      return;
    }

    try {
      for await (const entry of handle) {
        const child = join(directory, entry.name);

        // 输出在输入目录内时必须在发现阶段排除，避免把本次产物再次当作源图。
        if (outputDir !== undefined && isPathInside(child, outputDir, true)) {
          skipped += 1;
          continue;
        }

        let stats: Stats;
        try {
          stats = await lstat(child);
        } catch (error) {
          addDiscoveryFailure(items, child, `无法读取文件状态：${errorMessage(error)}`);
          continue;
        }

        if (stats.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        if (stats.isDirectory()) {
          if (recursive) {
            await visit(child);
          } else {
            skipped += 1;
          }
          continue;
        }
        if (!stats.isFile()) {
          skipped += 1;
          continue;
        }
        if (!isSupportedImage(child)) {
          skipped += 1;
          continue;
        }

        const key = pathKey(child);
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          files.push({ path: child, relativePath: relative(root, child) });
        }
      }
    } catch (error) {
      // readdir 过程中可能在已返回部分条目后失败；保留已发现文件并继续其他输入。
      addDiscoveryFailure(items, directory, `读取目录时失败：${errorMessage(error)}`);
    }
  }

  await visit(root);
  return skipped;
}

/** 解析文件与目录输入，并确定每个文件在输出目录中的相对路径。 */
async function discoverInputs(
  inputPaths: string[],
  outputDir: string | undefined,
  recursive: boolean,
): Promise<DiscoveryResult> {
  const roots: InputRoot[] = [];
  const files: InputFile[] = [];
  const items: BatchItem[] = [];
  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  let skipped = 0;

  for (const inputPath of inputPaths) {
    const absolute = resolve(inputPath);
    const key = pathKey(absolute);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);

    try {
      await assertNoSymlinkComponents(absolute);
    } catch (error) {
      addDiscoveryFailure(items, absolute, error);
      continue;
    }

    let stats: Stats;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      addDiscoveryFailure(items, absolute, `输入不存在或无法读取：${errorMessage(error)}`);
      continue;
    }

    if (stats.isSymbolicLink()) {
      addDiscoveryFailure(items, absolute, '输入是软链接或目录 junction，已拒绝');
      continue;
    }
    if (stats.isDirectory()) {
      roots.push({ path: absolute, kind: 'directory' });
      continue;
    }
    if (stats.isFile()) {
      roots.push({ path: absolute, kind: 'file' });
      if (!isSupportedImage(absolute)) {
        addDiscoveryFailure(items, absolute, '不支持的图片扩展名；支持 png、jpg、jpeg、webp');
        continue;
      }
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        files.push({ path: absolute, relativePath: basename(absolute) });
      }
      continue;
    }
    addDiscoveryFailure(items, absolute, '输入既不是普通文件也不是目录');
  }

  const directoryRoots = roots.filter((root) => root.kind === 'directory');
  const multipleDirectoryInputs = directoryRoots.length > 1;
  for (const root of directoryRoots) {
    const before = files.length;
    skipped += await collectDirectory(root.path, outputDir, recursive, files, seenFiles, items);
    for (let index = before; index < files.length; index += 1) {
      const file = files[index];
      if (file === undefined) continue;
      const relativePath = file.relativePath;
      file.relativePath = multipleDirectoryInputs
        ? join(basename(root.path), relativePath)
        : relativePath;
    }
  }

  return { roots, files, items, skipped };
}

/** 以同目录临时文件加独占硬链接的方式原子发布，绝不覆盖既有路径。 */
async function writeNoClobber(targetPath: string, data: Buffer): Promise<void> {
  const parent = dirname(targetPath);
  await assertNoSymlinkComponents(parent);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(parent);

  let temporaryPath = '';
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomBytes(10).toString('hex');
    const candidate = join(parent, `.${basename(targetPath)}.${process.pid}.${suffix}.tmp`);
    try {
      handle = await open(candidate, 'wx', 0o600);
      temporaryPath = candidate;
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
  }
  if (handle === undefined || temporaryPath === '') {
    throw new BatchInputError(`无法创建临时文件：${targetPath}`);
  }

  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, targetPath);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** 检查报告目标不会覆盖源文件、产物或已有文件。 */
async function validateReportTarget(
  reportPath: string,
  sourcePaths: Set<string>,
  outputPaths: Set<string>,
): Promise<void> {
  if (sourcePaths.has(pathKey(reportPath))) {
    throw new BatchInputError(`报告路径不能覆盖源文件：${reportPath}`);
  }
  if (outputPaths.has(pathKey(reportPath))) {
    throw new BatchInputError(`报告路径不能覆盖输出文件：${reportPath}`);
  }
  await assertNoSymlinkComponents(dirname(reportPath));
  try {
    await lstat(reportPath);
    throw new BatchInputError(`报告文件已存在，为避免覆盖已拒绝：${reportPath}`);
  } catch (error) {
    if (error instanceof BatchInputError) throw error;
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

/** 创建初始总计对象。 */
function createSummary(): BatchSummary {
  return {
    total: 0,
    compressed: 0,
    kept: 0,
    failed: 0,
    skipped: 0,
    inputBytes: 0,
    outputBytes: 0,
    unknownInputSize: 0,
    unknownOutputSize: 0,
  };
}

/** 根据每一项结果计算总计；原地失败项分别采用处理前及失败后的实际大小。 */
function summarize(items: BatchItem[], skipped: number, inPlace: boolean): BatchSummary {
  const summary = createSummary();
  summary.skipped = skipped;
  for (const item of items) {
    if (item.status === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    summary.total += 1;
    if (item.status === 'compressed') summary.compressed += 1;
    if (item.status === 'kept') summary.kept += 1;
    if (item.status === 'failed') summary.failed += 1;
    if (inPlace && item.status === 'failed') {
      if (item.inputBytes === undefined) summary.unknownInputSize += 1;
      if (item.outputBytes === undefined) summary.unknownOutputSize += 1;
    }
    if (item.inputBytes !== undefined && (item.status !== 'failed' || inPlace)) {
      summary.inputBytes += item.inputBytes;
    }
    if (item.outputBytes !== undefined && (item.status !== 'failed' || inPlace)) {
      summary.outputBytes += item.outputBytes;
    }
  }
  return summary;
}

/** 失败后分别记录处理前的大小和当前文件的真实大小，避免并发修改造成失真。 */
async function inPlaceFailure(path: string, error: unknown, inputBytes?: number): Promise<BatchItem> {
  const outputBytes = await currentFileSize(path);
  return { status: 'failed', inputPath: path, outputPath: path, error: errorMessage(error),
    ...(inputBytes === undefined ? {} : { inputBytes }),
    ...(outputBytes === undefined ? {} : { outputBytes }) };
}

/** 校验引擎结果，防止把错误格式写到原扩展名文件。 */
function validateCompressionResult(
  sourcePath: string,
  expectedFormat: ImageFormat,
  result: CompressionResult,
): void {
  if (result.format !== expectedFormat) {
    throw new BatchInputError(
      `引擎返回格式 ${result.format} 与扩展名 ${extname(sourcePath)} 不一致，已拒绝写入`,
    );
  }
  if (!Buffer.isBuffer(result.data)) {
    throw new BatchInputError('引擎没有返回有效图片数据');
  }
  if (result.status !== 'compressed' && result.status !== 'kept') {
    throw new BatchInputError(`引擎返回未知状态：${String(result.status)}`);
  }
}

/** 按发现顺序逐张处理图片，失败项不会阻断后续图片。 */
async function processFiles(
  files: InputFile[],
  outputDir: string | undefined,
  maxPixels: number,
  discoveryItems: BatchItem[],
): Promise<BatchItem[]> {
  const items = [...discoveryItems];
  const sourcePaths = new Set(files.map((file) => pathKey(file.path)));
  const publishedPaths = new Set<string>();

  for (const file of files) {
    const outputPath = outputDir === undefined ? file.path : resolve(outputDir, file.relativePath);
    const expectedFormat = formatForExtension(file.path);
    if (expectedFormat === undefined) {
      addDiscoveryFailure(items, file.path, '不支持的图片扩展名；支持 png、jpg、jpeg、webp', outputPath);
      continue;
    }
    if (outputDir !== undefined && samePath(file.path, outputPath)) {
      addDiscoveryFailure(items, file.path, '输出路径与源文件相同，已拒绝覆盖', outputPath);
      continue;
    }
    const outputKey = pathKey(outputPath);
    if (outputDir !== undefined && sourcePaths.has(outputKey)) {
      addDiscoveryFailure(items, file.path, `输出路径会覆盖源文件，已拒绝：${outputPath}`, outputPath);
      continue;
    }
    if (publishedPaths.has(outputKey)) {
      addDiscoveryFailure(items, file.path, `输出路径与另一项冲突，已拒绝覆盖：${outputPath}`, outputPath);
      continue;
    }
    if (outputDir !== undefined) {
      try {
        await lstat(outputPath);
        addDiscoveryFailure(items, file.path, `输出文件已存在，为避免覆盖已跳过：${outputPath}`, outputPath);
        continue;
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          addDiscoveryFailure(items, file.path, error, outputPath);
          continue;
        }
      }
    }

    let input: Buffer;
    let stats: Stats | undefined;
    try {
      await assertNoSymlinkComponents(file.path);
      stats = await lstat(file.path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new BatchInputError('源文件已变为软链接或不再是普通文件');
      }
      if (stats.size > MAX_INPUT_BYTES) {
        throw new BatchInputError(
          `文件超过 128 MiB 上限，已跳过以避免内存峰值；请先缩小文件：${file.path}`,
        );
      }
      input = await readFile(file.path);
    } catch (error) {
      if (outputDir === undefined) {
        items.push(await inPlaceFailure(file.path, error,
          stats?.isFile() && !stats.isSymbolicLink() ? stats.size : undefined));
      } else addDiscoveryFailure(items, file.path, error, outputPath);
      continue;
    }

    let result: CompressionResult;
    try {
      result = await compressImage(input, { maxPixels });
      validateCompressionResult(file.path, expectedFormat, result);
      if (outputDir === undefined) {
        // 保留原图时不触碰文件，以保留其字节和修改时间。
        if (result.status === 'compressed') await replaceInPlace(file.path, input, result.data, stats);
        else await assertSourceUnchanged(file.path, input, stats);
      } else {
        await writeNoClobber(outputPath, result.data);
      }
    } catch (error) {
      if (outputDir === undefined) items.push(await inPlaceFailure(file.path, error, stats.size));
      else addDiscoveryFailure(items, file.path, error, outputPath);
      continue;
    }

    publishedPaths.add(outputKey);
    items.push({
      status: result.status,
      inputPath: file.path,
      outputPath,
      format: result.format,
      inputBytes: input.byteLength,
      outputBytes: result.data.byteLength,
      strategy: result.strategy,
      score: result.score,
      attempts: result.attempts,
    });
  }

  return items;
}

/** 把报告序列化为 UTF-8 JSON，并使用同样的无覆盖发布规则写出。 */
async function writeReport(reportPath: string, report: BatchReport): Promise<void> {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeNoClobber(reportPath, Buffer.from(body, 'utf8'));
}

/** 批量压缩文件或目录，并在完成后可选写出 JSON 报告。 */
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const inPlace = options.inPlace ?? false;
  if (inPlace && options.outputDir !== undefined) throw new BatchInputError('原地替换不能指定输出目录');
  const inputPaths = (inPlace && options.inputPaths.length === 0 ? [cwd] : options.inputPaths)
    .map((inputPath) => absolutePath(inputPath, cwd));
  if (inputPaths.length === 0) throw new EmptyInputError();

  const outputDir = inPlace ? undefined : absolutePath(options.outputDir ?? DEFAULT_OUTPUT_DIRECTORY, cwd);
  const recursive = options.recursive ?? inPlace;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new BatchInputError('maxPixels 必须是正整数');
  }

  if (outputDir !== undefined) await validateOutputDirectory(outputDir);
  const discovery = await discoverInputs(inputPaths, outputDir, recursive);
  if (outputDir !== undefined) validateOutputRelation(outputDir, discovery.roots);

  if (discovery.files.length === 0 && discovery.items.length === 0) {
    throw new EmptyInputError();
  }

  const plannedOutputPaths = new Set<string>();
  for (const file of discovery.files) {
    plannedOutputPaths.add(pathKey(outputDir === undefined ? file.path : resolve(outputDir, file.relativePath)));
  }
  const reportPath = options.reportPath === undefined
    ? undefined
    : absolutePath(options.reportPath, cwd);
  if (reportPath !== undefined) {
    await validateReportTarget(
      reportPath,
      new Set(discovery.files.map((file) => pathKey(file.path))),
      plannedOutputPaths,
    );
  }

  const files = await processFiles(
    discovery.files,
    outputDir,
    maxPixels,
    discovery.items,
  );
  const summary = summarize(files, discovery.skipped, inPlace);
  const report: BatchReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    options: {
      inputPaths,
      ...(outputDir === undefined ? {} : { outputDir }),
      inPlace,
      recursive,
      maxPixels,
    },
    summary,
    files,
  };

  let reportError: string | undefined;
  if (reportPath !== undefined) {
    try {
      await writeReport(reportPath, report);
    } catch (error) {
      reportError = errorMessage(error);
    }
  }

  return { summary, files, report, reportPath, reportError };
}
