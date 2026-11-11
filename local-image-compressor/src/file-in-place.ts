import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';

/** 检查路径组件，拒绝软链接和目录 junction。 */
export async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const absolute = resolve(targetPath);
  const root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`路径包含软链接或目录 junction，已拒绝：${current}`);
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') break;
      throw error;
    }
  }
}

/** 检查处理期间源图身份、元数据和内容是否仍与读取前一致。 */
export async function assertSourceUnchanged(path: string, original: Buffer, expected: Stats): Promise<void> {
  await assertNoSymlinkComponents(path);
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev ||
    current.ino !== expected.ino || current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs ||
    !(await readFile(path)).equals(original)) {
    throw new Error(`源文件已发生变化，拒绝替换或保留：${path}`);
  }
  await assertNoSymlinkComponents(path);
}

/** 尽力读取失败后现存普通文件的真实大小；无法安全读取时返回未知。 */
export async function currentFileSize(path: string): Promise<number | undefined> {
  let handle: FileHandle | undefined;
  try {
    await assertNoSymlinkComponents(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    handle = await open(path, 'r');
    const opened = await handle.stat();
    await assertNoSymlinkComponents(path);
    const after = await lstat(path);
    if (!opened.isFile() || !after.isFile() || after.isSymbolicLink() ||
      opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
      before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return after.size;
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

/** 以同目录独占临时文件替换源文件，并在提交前检查原文件没有被其他进程修改。 */
export async function replaceInPlace(path: string, original: Buffer, data: Buffer, expected: Stats): Promise<void> {
  await assertNoSymlinkComponents(path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(10).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(temporary, 'wx', expected.mode & 0o777);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // 再检查文件身份及内容，避免压缩过程中覆盖其他进程已经保存的新内容。
    await assertSourceUnchanged(path, original, expected);
    await rename(temporary, path);
    created = false;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
