import { z } from 'zod';
import path from 'node:path';

const MAX_WRITE_BYTES = 256 * 1024;
// touch only accepts --content; keep its Base64 argument below Windows' command line limit.
const MAX_CREATE_BYTES = 16 * 1024;
const remotePath = z.string().min(1).max(4096)
  .refine(value => value.startsWith('/') && !value.includes('\0'),
    '使用列表或搜索返回的 NAS 绝对路径。');
const localPath = z.string().min(1).max(4096)
  .refine(value => path.isAbsolute(value) && !value.includes('\0') &&
    !value.startsWith('\\\\.\\') && !value.startsWith('\\\\?\\'),
  '提供普通本地绝对路径，不能使用标准输入或设备路径。');
const permissionMode = (value) => z.string().regex(/^(?:0o)?[0-7]{3,4}$/,
  '权限必须是数字八进制，例如 0644、0755 或 0o755。').default(value);
const onConflict = z.enum(['rename', 'skip', 'replace']).default('rename');
const dryRun = z.boolean().default(false);
const textContent = (maxBytes, message) => z.string()
  .refine(value => Buffer.byteLength(value, 'utf8') <= maxBytes, message);
const writeAnnotations = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
};
const destructiveAnnotations = { ...writeAnnotations, destructiveHint: true };
const scope = '仅操作用户指定的对象；写操作失败后先查询当前状态，不自动重试。权限由绿联令牌与 NAS 账户决定。';

function executionFlags(dry_run, confirm = false) {
  return dry_run ? ['--dry-run'] : confirm ? ['--yes'] : [];
}

export function registerFileWriteTools(tool) {
  tool('ugreen_upload_file',
    `把一个本地普通文件上传到指定 NAS 绝对路径。remote_path 以 / 结尾时沿用本地文件名；默认同名自动改名，replace 会覆盖。verify 核对 SHA-256；dry_run 仅预演，不上传内容。${scope}`,
    z.object({
      local_path: localPath, remote_path: remotePath, on_conflict: onConflict,
      verify: z.boolean().default(false), dry_run: dryRun,
    }).strict(),
    ({ local_path, remote_path, on_conflict, verify, dry_run }, options) => options.run([
      'file', 'upload', local_path, remote_path, '--on-conflict', on_conflict,
      ...(verify ? ['--verify'] : []), '--stream-timeout', '1800',
      ...executionFlags(dry_run, on_conflict === 'replace'),
    ], { timeoutMs: 1830000 }), destructiveAnnotations);

  tool('ugreen_create_directory',
    `在指定 NAS 路径创建普通目录。parents 仅在用户要求创建缺失父目录时使用；mode 是八进制权限。创建共享注册项应使用专门的共享工具。${scope}`,
    z.object({
      path: remotePath, parents: z.boolean().default(false), mode: permissionMode('0755'), dry_run: dryRun,
    }).strict(),
    ({ path: folder, parents, mode, dry_run }, options) => options.run([
      'file', 'mkdir', folder, '--mode', mode, ...(parents ? ['--parents'] : []), ...executionFlags(dry_run),
    ]), { ...writeAnnotations, idempotentHint: true });

  tool('ugreen_create_file',
    `创建一个 NAS 文件，content 为 UTF-8 文本（可为空），最多 16 KiB；更大或二进制内容使用 ugreen_upload_file。默认 exclusive=true，已存在时失败；mode 是八进制权限。${scope}`,
    z.object({
      path: remotePath,
      content: textContent(MAX_CREATE_BYTES, '新建文本最多 16 KiB（UTF-8）；更大内容请保存到本地后上传。').default(''),
      mode: permissionMode('0644'), exclusive: z.boolean().default(true), dry_run: dryRun,
    }).strict(),
    ({ path: file, content, mode, exclusive, dry_run }, options) => options.run([
      'file', 'touch', file, '--content', Buffer.from(content, 'utf8').toString('base64'), '--base64',
      '--mode', mode, ...(exclusive ? ['--exclusive'] : []), ...executionFlags(dry_run),
    ]), { ...destructiveAnnotations, idempotentHint: true });

  tool('ugreen_write_file',
    `写入一个已存在的 NAS 文件，UTF-8 内容最多 256 KiB。write 覆盖原内容；append 追加；patch 按字节 offset 局部写入。仅 patch 接受 offset；新建文件使用 ugreen_create_file 或上传。先用 dry_run 核对重要覆盖。${scope}`,
    z.object({
      path: remotePath,
      content: textContent(MAX_WRITE_BYTES, '每次写入最多 256 KiB（UTF-8）；更大文件请上传。'),
      mode: z.enum(['write', 'append', 'patch']).default('write'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), dry_run: dryRun,
    }).strict().superRefine((value, context) => {
      if (value.mode === 'patch' && value.offset === undefined) {
        context.addIssue({ code: 'custom', path: ['offset'], message: 'patch 模式必须指定字节 offset。' });
      } else if (value.mode !== 'patch' && value.offset !== undefined) {
        context.addIssue({ code: 'custom', path: ['offset'], message: '只有 patch 模式可指定 offset。' });
      }
    }),
    ({ path: file, content, mode, offset, dry_run }, options) => options.run([
      'file', 'tee', file, '--mode', mode, ...(offset === undefined ? [] : ['--offset', String(offset)]),
      ...executionFlags(dry_run, true),
    ], { input: Buffer.from(content, 'utf8') }), destructiveAnnotations);

  tool('ugreen_copy_file',
    `复制一个 NAS 文件或目录到已存在的目标目录，保留原名。destination_directory 必须是目录，不能写“目录/新文件名”；需要改名时另行移动为纯文件名。默认同名自动改名，replace 会覆盖；先 dry_run 核对覆盖影响。${scope}`,
    z.object({
      source_path: remotePath, destination_directory: remotePath, on_conflict: onConflict, dry_run: dryRun,
    }).strict(),
    ({ source_path, destination_directory, on_conflict, dry_run }, options) => options.run([
      'file', 'cp', source_path, destination_directory, '--on-conflict', on_conflict, ...executionFlags(dry_run),
    ]), destructiveAnnotations);

  tool('ugreen_move_file',
    `移动或重命名一个 NAS 文件/目录。跨目录 destination 必须是已存在的目录绝对路径；同目录改名只能给不含斜杠的纯文件名。跨目录改名分成两步，不使用“目录/新文件名”。默认同名自动改名，replace 会覆盖；先 dry_run 核对。${scope}`,
    z.object({
      source_path: remotePath,
      destination: z.string().min(1).max(4096).refine(value => !value.includes('\0') &&
        (value.startsWith('/') || (!value.includes('/') && !value.includes('\\') &&
          !value.startsWith('-') && value !== '.' && value !== '..')),
      '目标必须为 NAS 绝对目录路径或不含斜杠的纯新文件名。'),
      on_conflict: onConflict, dry_run: dryRun,
    }).strict(),
    ({ source_path, destination, on_conflict, dry_run }, options) => options.run([
      'file', 'mv', source_path, destination, '--on-conflict', on_conflict, ...executionFlags(dry_run, true),
    ]), destructiveAnnotations);

  tool('ugreen_delete_file',
    `删除用户指定的一个 NAS 文件或目录，默认移入回收站。recursive 默认为 false；删除目录及其内容必须明确指定 true。permanent 仅在用户明确要求永久删除时使用，永久删除不能恢复。先 dry_run 核对范围；CLI 会保护共享根目录并复核删除结果。回收站路径见 data.receipt.final_path，保存它以便恢复。${scope}`,
    z.object({
      path: remotePath, recursive: z.boolean().default(false),
      permanent: z.boolean().default(false), dry_run: dryRun,
    }).strict(),
    async ({ path: file, recursive, permanent, dry_run }, options) => {
      // unc rm has no recursive switch: its native directory deletion includes contents.
      // Check the official protobuf type before allowing the nonrecursive form.
      if (!recursive) {
        const metadata = await options.run(['file', 'stat', file]);
        const type = metadata.items?.[0]?.data?.stat?.type;
        if (type === 'FILE_TYPE_DIR') {
          throw new Error('目标是目录。仅在用户已要求删除该目录及其内容时，将 recursive 设为 true。');
        }
        if (type !== 'FILE_TYPE_FILE' && type !== 'FILE_TYPE_SYMLINK') {
          throw new Error('无法确认目标为普通文件或符号链接，未发送删除请求。请先查询元数据并核对删除范围。');
        }
      }
      return options.run([
        'file', 'rm', file, ...(permanent ? ['--permanent'] : []), ...executionFlags(dry_run, true),
      ]);
    }, { ...destructiveAnnotations, idempotentHint: true });

  tool('ugreen_restore_file',
    `从回收站恢复一个 NAS 文件或目录，recycle_path 必须使用删除结果 data.receipt.final_path 或回收站列表返回的路径。dry_run 无法确认路径真的处于回收站，不能把预演当作已恢复。${scope}`,
    z.object({ recycle_path: remotePath, dry_run: dryRun }).strict(),
    ({ recycle_path, dry_run }, options) => options.run([
      'file', 'recover-recycle', recycle_path, ...executionFlags(dry_run),
    ]), writeAnnotations);
}
