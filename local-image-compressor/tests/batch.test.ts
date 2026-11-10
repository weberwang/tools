import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  EmptyInputError,
  runBatch,
  UnsafeOutputError,
} from '../src/batch.js';

/** 在临时目录中创建一张可被引擎读取的 PNG。 */
async function createPng(filePath: string, colour = { r: 40, g: 90, b: 140, alpha: 1 }): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, await sharp({
    create: { width: 48, height: 32, channels: 4, background: colour },
  }).png().toBuffer());
}

/** 为单个用例创建隔离目录，并在结束时清理。 */
async function withTempDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'local-image-compressor-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('多目录输入保留相对结构并用目录 basename 隔离同名文件', async () => {
  await withTempDirectory(async (directory) => {
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    const output = join(directory, 'output');
    await createPng(join(first, 'nested', 'picture.png'));
    await createPng(join(second, 'nested', 'picture.png'), { r: 120, g: 30, b: 70, alpha: 1 });

    const result = await runBatch({
      inputPaths: [first, second],
      outputDir: output,
      recursive: true,
    });

    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.total, 2);
    assert.equal((await stat(join(output, 'first', 'nested', 'picture.png'))).isFile(), true);
    assert.equal((await stat(join(output, 'second', 'nested', 'picture.png'))).isFile(), true);
  });
});

test('输出为输入子目录时排除整个输出子树', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const output = join(input, 'compressed');
    await createPng(join(input, 'source.png'));
    await createPng(join(output, 'old.png'));

    const result = await runBatch({
      inputPaths: [input],
      outputDir: output,
      recursive: true,
    });

    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.total, 1);
    assert.equal((await stat(join(output, 'source.png'))).isFile(), true);
    assert.equal((await stat(join(output, 'old.png'))).isFile(), true);
  });
});

test('输出目录等于或包含输入目录时拒绝执行', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    await createPng(join(input, 'source.png'));

    await assert.rejects(
      runBatch({ inputPaths: [input], outputDir: input }),
      UnsafeOutputError,
    );
    await assert.rejects(
      runBatch({ inputPaths: [input], outputDir: directory }),
      UnsafeOutputError,
    );
  });
});

test('已有输出不会被覆盖，其他图片仍继续处理', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const output = join(directory, 'output');
    const existing = join(output, 'existing.png');
    await createPng(join(input, 'existing.png'));
    await createPng(join(input, 'new.png'), { r: 10, g: 180, b: 50, alpha: 1 });
    await mkdir(output, { recursive: true });
    const sentinel = Buffer.from('do-not-overwrite');
    await writeFile(existing, sentinel);

    const result = await runBatch({
      inputPaths: [input],
      outputDir: output,
      recursive: true,
    });

    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.compressed + result.summary.kept, 1);
    assert.deepEqual(await readFile(existing), sentinel);
    assert.equal((await stat(join(output, 'new.png'))).isFile(), true);
  });
});

test('显式不支持文件记为失败但不阻断有效图片', async () => {
  await withTempDirectory(async (directory) => {
    const image = join(directory, 'valid.png');
    const text = join(directory, 'notes.gif');
    const output = join(directory, 'output');
    await createPng(image);
    await writeFile(text, 'not a supported input');

    const result = await runBatch({
      inputPaths: [text, image],
      outputDir: output,
    });

    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.compressed + result.summary.kept, 1);
    assert.equal((await stat(join(output, 'valid.png'))).isFile(), true);
  });
});

test('JSON 报告记录成功与失败，并拒绝覆盖已有报告', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const output = join(directory, 'output');
    const report = join(directory, 'report.json');
    await createPng(join(input, 'picture.png'));

    const result = await runBatch({
      inputPaths: [input],
      outputDir: output,
      reportPath: report,
    });
    const reportData = JSON.parse(await readFile(report, 'utf8')) as {
      version: number;
      files: Array<{ status: string; inputPath: string; outputPath?: string;
        attempts?: Array<{ strategy: string; status: string; rejectionReason?: string }> }>;
    };
    assert.equal(result.reportError, undefined);
    assert.equal(reportData.version, 1);
    assert.equal(reportData.files.length, 1);
    assert.match(reportData.files[0]?.inputPath ?? '', /picture\.png$/);
    assert.match(reportData.files[0]?.outputPath ?? '', /picture\.png$/);
    assert.ok(reportData.files[0]?.attempts?.length);
    assert.ok(reportData.files[0]?.attempts?.every(attempt => attempt.strategy && attempt.status));

    await assert.rejects(
      runBatch({ inputPaths: [input], outputDir: join(directory, 'second'), reportPath: report }),
      /报告文件已存在/,
    );
  });
});

test('空目录没有图片时报告空输入', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'empty');
    await mkdir(input);

    await assert.rejects(
      runBatch({ inputPaths: [input], outputDir: join(directory, 'output') }),
      EmptyInputError,
    );
  });
});

test('报告路径不能指向源图或预定输出', async () => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const output = join(directory, 'output');
    const source = join(input, 'picture.png');
    await createPng(source);

    await assert.rejects(
      runBatch({ inputPaths: [input], outputDir: output, reportPath: source }),
      /报告路径不能覆盖源文件/,
    );
    await assert.rejects(
      runBatch({
        inputPaths: [input],
        outputDir: output,
        reportPath: join(output, 'picture.png'),
      }),
      /报告路径不能覆盖输出文件/,
    );
  });
});

test('扩展名与真实格式不符时失败，但继续下一项', async () => {
  await withTempDirectory(async (directory) => {
    const mismatch = join(directory, 'mismatch.png');
    const valid = join(directory, 'valid.png');
    const output = join(directory, 'output');
    await mkdir(directory, { recursive: true });
    await writeFile(mismatch, await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 80 } },
    }).jpeg().toBuffer());
    await createPng(valid);

    const result = await runBatch({
      inputPaths: [mismatch, valid],
      outputDir: output,
    });

    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.compressed + result.summary.kept, 1);
    assert.equal((await stat(join(output, 'valid.png'))).isFile(), true);
    await assert.rejects(stat(join(output, 'mismatch.png')));
  });
});

test('损坏图片失败后继续处理有效图片', async () => {
  await withTempDirectory(async (directory) => {
    const broken = join(directory, 'broken.png');
    const valid = join(directory, 'valid.png');
    const output = join(directory, 'output');
    await writeFile(broken, Buffer.from('not-an-image'));
    await createPng(valid);

    const result = await runBatch({
      inputPaths: [broken, valid],
      outputDir: output,
    });

    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.compressed + result.summary.kept, 1);
    assert.equal((await stat(join(output, 'valid.png'))).isFile(), true);
  });
});

test('递归输入跳过 Windows 目录 junction', { skip: process.platform !== 'win32' }, async (context) => {
  await withTempDirectory(async (directory) => {
    const input = join(directory, 'images');
    const external = join(directory, 'external');
    const junction = join(input, 'external-link');
    const output = join(directory, 'output');
    await createPng(join(input, 'source.png'));
    await createPng(join(external, 'outside.png'));
    try {
      await symlink(external, junction, 'junction');
    } catch (error) {
      if (error instanceof Error && ['EPERM', 'EACCES'].some((code) => error.message.includes(code))) {
        context.skip('当前 Windows 环境不允许创建 junction');
        return;
      }
      throw error;
    }

    const result = await runBatch({ inputPaths: [input], outputDir: output, recursive: true });
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.compressed + result.summary.kept, 1);
    assert.equal(result.summary.skipped >= 1, true);
    await assert.rejects(stat(join(output, 'external-link', 'outside.png')));
  });
});
