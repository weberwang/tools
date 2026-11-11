import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { HELP_TEXT, main, parseCliArgs, type CliIO } from '../src/cli.js';

/** 创建 CLI 测试使用的最小有效 PNG。 */
async function createPng(filePath: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 1 } },
  }).png().toFile(filePath);
}

/** 收集可断言的终端输出。 */
function captureIO(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

/** 为 CLI 测试创建隔离目录，并在结束时清理。 */
async function withTempDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'local-image-compressor-cli-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('--help 输出中文帮助且不要求输入', async () => {
  const captured = captureIO();
  const exitCode = await main(['--help'], captured.io);

  assert.equal(exitCode, 0);
  assert.equal(captured.stderr.length, 0);
  assert.equal(captured.stdout.join(''), HELP_TEXT);
});

test('非法 max-pixels 返回参数错误退出码', async () => {
  const captured = captureIO();
  const exitCode = await main(['--max-pixels', '0', 'input.png'], captured.io);

  assert.equal(exitCode, 2);
  assert.match(captured.stderr.join(''), /--max-pixels 必须是正整数/);
});

test('解析默认值与多目录前缀相关参数', () => {
  const parsed = parseCliArgs(['-r', '--max-pixels', '12345', 'first', 'second']);
  assert.notEqual(parsed, 'help');
  if (parsed === 'help') return;
  assert.deepEqual(parsed.inputPaths, ['first', 'second']);
  assert.equal(parsed.recursive, true);
  assert.equal(parsed.maxPixels, 12345);
});

test('CLI 成功处理目录、写出报告并打印中文总计', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const output = join(directory, 'compressed');
    const report = join(directory, 'summary.json');
    await createPng(join(input, 'nested', 'picture.png'));
    const captured = captureIO();

    const exitCode = await main([
      '--recursive',
      '--max-pixels', '100000',
      '--output', output,
      '--report', report,
      input,
    ], captured.io);

    assert.equal(exitCode, 0);
    assert.match(captured.stdout.join(''), /完成：成功 1/);
    assert.equal((await stat(join(output, 'nested', 'picture.png'))).isFile(), true);
    const reportData = JSON.parse(await readFile(report, 'utf8')) as {
      options: { maxPixels: number; recursive: boolean };
    };
    assert.equal('preset' in reportData.options, false);
    assert.equal(reportData.options.maxPixels, 100000);
    assert.equal(reportData.options.recursive, true);
  });
});

test('不再接受已移除的质量档位参数', async () => {
  const captured = captureIO();
  const exitCode = await main(['--preset', 'gentle', 'input.png'], captured.io);
  assert.equal(exitCode, 2);
  assert.equal(captured.stdout.length, 0);
  assert.doesNotMatch(HELP_TEXT, /--preset/);
});

test('原地模式默认递归处理当前工作目录，并拒绝输出目录参数', async () => {
  const parsed = parseCliArgs(['--in-place'], process.cwd());
  assert.notEqual(parsed, 'help');
  if (parsed === 'help') return;
  assert.deepEqual(parsed.inputPaths, [process.cwd()]);
  assert.equal(parsed.inPlace, true);
  assert.equal(parsed.recursive, true);
  assert.equal(parsed.outputDir, undefined);
  const captured = captureIO();
  assert.equal(await main(['--in-place', '--output', 'unused'], captured.io), 2);
  assert.match(captured.stderr.join(''), /--in-place 不能与 --output 同时使用/);
  assert.equal(captured.stdout.length, 0);
});

test('原地 CLI 递归替换同名图片，并输出实际字节总计与明确口径的压缩比', async () => {
  await withTempDirectory(async (directory) => {
    const first = join(directory, 'picture.png');
    const second = join(directory, 'nested', 'picture.png');
    const reportPath = join(directory, 'report.json');
    await mkdir(join(directory, 'nested'));
    // 高彩噪声会超出旧误差门槛，用真实原地入口验证它仍按体积采用并准确统计。
    const pixels = Buffer.alloc(64 * 64 * 4);
    let seed = 42;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[offset + channel] = seed >>> 24;
      }
      pixels[offset + 3] = 255;
    }
    const original = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } })
      .png({ compressionLevel: 0 }).toBuffer();
    await writeFile(first, original);
    await writeFile(second, original);
    const meta = Buffer.from('{"uuid":"keep-this-uuid"}');
    await writeFile(`${first}.meta`, meta);
    const captured = captureIO();

    assert.equal(await main(['--in-place', '--report', reportPath, directory], captured.io), 0);
    const outputBytes = (await stat(first)).size + (await stat(second)).size;
    const inputBytes = original.length * 2;
    assert.ok(outputBytes < inputBytes);
    assert.deepEqual(await readFile(`${first}.meta`), meta);
    const stdout = captured.stdout.join('');
    assert.ok(stdout.includes(`原始总大小：`));
    assert.ok(stdout.includes(`（${inputBytes} 字节）`));
    assert.ok(stdout.includes(`压缩后总大小：`));
    assert.ok(stdout.includes(`（${outputBytes} 字节）`));
    assert.ok(stdout.includes(`压缩比（压缩后/原始）：${(outputBytes / inputBytes * 100).toFixed(2)}%`));
    assert.ok(stdout.includes(`节省比例：${((1 - outputBytes / inputBytes) * 100).toFixed(2)}%`));
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      options: { inPlace: boolean }; summary: { inputBytes: number; outputBytes: number };
      files: Array<{ status: string; score: { rmse: number; worstBlockRmse: number } }>;
    };
    assert.equal(report.options.inPlace, true);
    assert.equal(report.summary.inputBytes, inputBytes);
    assert.equal(report.summary.outputBytes, outputBytes);
    assert.equal(report.files.length, 2);
    assert.ok(report.files.every(file => file.status === 'compressed'
      && (file.score.rmse > 4 || file.score.worstBlockRmse > 12)));
  });
});

test('原地 CLI 损坏图片返回失败并保留原字节，统计失败项的原始大小', async () => {
  await withTempDirectory(async (directory) => {
    const broken = join(directory, 'broken.png');
    const original = Buffer.from('invalid-png');
    await writeFile(broken, original);
    const captured = captureIO();
    assert.equal(await main(['--in-place', directory], captured.io), 1);
    assert.deepEqual(await readFile(broken), original);
    const stdout = captured.stdout.join('');
    assert.match(stdout, /失败 1/);
    assert.match(stdout, /压缩比（压缩后\/原始）：100\.00%/);
    assert.match(stdout, /节省比例：0\.00%/);
    assert.doesNotMatch(stdout, /NaN|Infinity/);
  });
});

test('原地 CLI 无法确定文件大小时标明不完整统计并停止计算比率', async () => {
  await withTempDirectory(async (directory) => {
    const captured = captureIO();
    assert.equal(await main(['--in-place', join(directory, 'missing.png')], captured.io), 1);
    const stdout = captured.stdout.join('');
    assert.match(stdout, /统计不完整/);
    assert.match(stdout, /压缩比（压缩后\/原始）：不适用（统计不完整）/);
    assert.doesNotMatch(stdout, /NaN|Infinity/);
  });
});
