import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { runBatch } from '../src/batch.js';
import { assertSourceUnchanged, currentFileSize, replaceInPlace } from '../src/file-in-place.js';

/** 建立可压缩图片，使测试能够实际观察到原地替换。 */
async function createPng(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  const data = await sharp({
    create: { width: 128, height: 128, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 1 } },
  }).png({ compressionLevel: 0 }).toBuffer();
  await writeFile(path, data);
  return data;
}

/** 使用独立临时目录隔离测试，不接触工作区或用户图片。 */
async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'local-image-in-place-'));
  try {
    await callback(directory);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('默认从当前目录递归压缩并原地替换，同名文件独立统计', async () => {
  await withTempDirectory(async (directory) => {
    const first = join(directory, 'one', 'image.png');
    const second = join(directory, 'two', 'image.png');
    const inputBytes = (await createPng(first)).length + (await createPng(second)).length;
    const result = await runBatch({ inputPaths: [], cwd: directory, inPlace: true });

    assert.equal(result.summary.compressed, 2);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.inputBytes, inputBytes);
    assert.equal(result.summary.outputBytes, (await stat(first)).size + (await stat(second)).size);
    assert(result.summary.outputBytes < inputBytes);
    assert.equal(result.report.options.inPlace, true);
    assert.equal(result.report.options.recursive, true);
    assert.equal(result.report.options.outputDir, undefined);
    assert.deepEqual(result.files.map(item => item.outputPath).sort(), [first, second].sort());
  });
});

test('无收益图片保留原始字节和修改时间，损坏图片计入原始与最终大小并继续', async () => {
  await withTempDirectory(async (directory) => {
    const tiny = join(directory, 'tiny.png');
    const broken = join(directory, 'broken.png');
    const valid = join(directory, 'nested', 'valid.png');
    const originalTiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'red' },
    }).png().toBuffer();
    const originalBroken = Buffer.from('不是图片');
    await writeFile(tiny, originalTiny);
    await writeFile(broken, originalBroken);
    const originalValid = await createPng(valid);
    const before = await stat(tiny);
    const result = await runBatch({ inputPaths: [directory], inPlace: true });

    assert.equal(result.summary.kept, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.compressed, 1);
    assert.deepEqual(await readFile(tiny), originalTiny);
    assert.deepEqual(await readFile(broken), originalBroken);
    assert.equal((await stat(tiny)).mtimeMs, before.mtimeMs);
    assert.equal(result.summary.inputBytes, originalTiny.length + originalBroken.length + originalValid.length);
    assert.equal(result.summary.outputBytes, originalTiny.length + originalBroken.length + (await stat(valid)).size);
  });
});

test('冲突参数与报告路径在替换前被拒绝', async () => {
  await withTempDirectory(async (directory) => {
    const image = join(directory, 'source.png');
    const original = await createPng(image);
    await assert.rejects(runBatch({ inputPaths: [directory], inPlace: true, outputDir: directory }), /原地替换不能指定输出目录/);
    await assert.rejects(runBatch({ inputPaths: [directory], inPlace: true, reportPath: image }), /报告路径不能覆盖源文件/);
    assert.deepEqual(await readFile(image), original);
  });
});

test('原地模式可写出报告并对重叠目录去重', async () => {
  await withTempDirectory(async (directory) => {
    const nested = join(directory, 'nested');
    const image = join(nested, 'image.png');
    const reportPath = join(directory, 'report.json');
    await createPng(image);
    const result = await runBatch({ inputPaths: [directory, nested], inPlace: true, reportPath });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { files: unknown[] };
    assert.equal(result.summary.total, 1);
    assert.equal(report.files.length, 1);
    assert.equal(result.reportError, undefined);
  });
});

test('源图被其他进程修改后拒绝替换并清理临时文件', async () => {
  await withTempDirectory(async (directory) => {
    const image = join(directory, 'source.png');
    const original = await createPng(image);
    const before = await stat(image);
    const changed = Buffer.from('并发保存内容');
    await writeFile(image, changed);
    await assert.rejects(replaceInPlace(image, original, Buffer.from('候选内容'), before), /源文件已发生变化/);
    assert.deepEqual(await readFile(image), changed);
    assert.equal(await currentFileSize(image), changed.length);
    assert.deepEqual(await readdir(directory), ['source.png']);
  });
});

test('保留原图也检查并发修改，并在文件消失后报告未知大小', async () => {
  await withTempDirectory(async (directory) => {
    const image = join(directory, 'source.png');
    const original = await createPng(image);
    const before = await stat(image);
    await assertSourceUnchanged(image, original, before);
    const changed = Buffer.from('新内容长度不同');
    await writeFile(image, changed);
    await assert.rejects(assertSourceUnchanged(image, original, before), /源文件已发生变化/);
    assert.equal(await currentFileSize(image), changed.length);
    assert.deepEqual(await readFile(image), changed);
    await rm(image);
    assert.equal(await currentFileSize(image), undefined);
  });
});

test('输入路径不存在时标记统计不完整', async () => {
  await withTempDirectory(async (directory) => {
    const missing = join(directory, 'missing.png');
    const result = await runBatch({ inputPaths: [missing], inPlace: true });
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.unknownInputSize, 1);
    assert.equal(result.summary.unknownOutputSize, 1);
    assert.equal(result.files[0]?.inputBytes, undefined);
    assert.equal(result.files[0]?.outputBytes, undefined);
  });
});

test('递归处理跳过指向目录外的链接', { skip: process.platform !== 'win32' }, async (context) => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside');
    const externalImage = join(outside, 'external.png');
    const original = await createPng(externalImage);
    await createPng(join(root, 'inner.png'));
    try {
      await symlink(outside, join(root, 'link'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('环境不允许创建链接');
        return;
      }
      throw error;
    }
    const result = await runBatch({ inputPaths: [root], inPlace: true });
    assert.equal(result.summary.total, 1);
    assert(result.summary.skipped >= 1);
    assert.deepEqual(await readFile(externalImage), original);
  });
});
