import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
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
