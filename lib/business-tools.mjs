import { z } from 'zod';
import catalog from './cli-commands.json' with { type: 'json' };

const MAX_ARGUMENT_LENGTH = 16384;
const MAX_STDIN_BYTES = 256 * 1024;
const STREAM_TIMEOUT_SECONDS = 1800;
const PROCESS_TIMEOUT_MS = 1830000;
const blockedFlags = new Set([
  'token', 'server-url', 'client-id', 'client-secret', 'output', 'format',
  'debug', 'verbose', 'help', 'insecure', 'dry-run', 'timeout',
]);
const booleanValues = new Map([
  ['1', true], ['t', true], ['T', true], ['TRUE', true], ['true', true], ['True', true],
  ['0', false], ['f', false], ['F', false], ['FALSE', false], ['false', false], ['False', false],
]);
const helpAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
const executeAnnotations = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
};

function commandFlags(command) {
  const entry = catalog.commands[command];
  return {
    ...catalog.globalFlags,
    ...Object.fromEntries((entry.inheritedFlags || []).map(name => [name, catalog.sharedFlags[name]])),
    ...entry.flags,
  };
}

// Consume arguments the way pflag does: values belong to the preceding option even
// when the value is literally "--token". Only option names are security-sensitive.
function parseArguments(command, args) {
  const flags = commandFlags(command);
  const shorts = Object.fromEntries(Object.entries(flags)
    .filter(([, metadata]) => metadata.short)
    .map(([name, metadata]) => [metadata.short, name]));
  const positionals = [];
  const values = new Map();
  let terminated = false;

  function checkFlag(name) {
    if (blockedFlags.has(name)) {
      throw new Error(`不能在 arguments 中设置 --${name}；认证、输出、日志和全局执行设置由连接器管理。预演请使用 dry_run。`);
    }
    if (!flags[name]) throw new Error(`当前业务命令不支持选项 --${name}，请先查询 ugreen_cli_help。`);
    return flags[name];
  }

  function record(name, value) {
    if (name === 'stream-timeout' &&
      (!/^[1-9]\d*$/.test(value) || Number(value) > STREAM_TIMEOUT_SECONDS)) {
      throw new Error(`--stream-timeout 必须是 1 到 ${STREAM_TIMEOUT_SECONDS} 的整数秒。`);
    }
    values.set(name, value);
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (terminated || !arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      terminated = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      const metadata = checkFlag(name);
      if (metadata.type === 'bool') {
        const literal = equals === -1 ? 'true' : arg.slice(equals + 1);
        if (!booleanValues.has(literal)) throw new Error(`--${name} 需要合法的布尔值。`);
        record(name, booleanValues.get(literal));
      } else {
        if (equals === -1 && index + 1 >= args.length) throw new Error(`--${name} 缺少参数值。`);
        record(name, equals === -1 ? args[++index] : arg.slice(equals + 1));
      }
      continue;
    }

    // pflag supports short-option clusters and attached values (-Ra, -d2,
    // -d=2). Walk each option so a blocked alias cannot hide in a cluster.
    const cluster = arg.slice(1);
    for (let cursor = 0; cursor < cluster.length; cursor++) {
      const shorthand = cluster[cursor];
      const name = shorts[shorthand];
      if (!name) throw new Error(`当前业务命令不支持短选项 -${shorthand}，请先查询 ugreen_cli_help。`);
      const metadata = checkFlag(name);
      const rest = cluster.slice(cursor + 1);
      if (metadata.type === 'bool') {
        if (rest.startsWith('=')) {
          const literal = rest.slice(1);
          if (!booleanValues.has(literal)) throw new Error(`-${shorthand} 需要合法的布尔值。`);
          record(name, booleanValues.get(literal));
          break;
        }
        record(name, true);
      } else {
        if (!rest && index + 1 >= args.length) throw new Error(`-${shorthand} 缺少参数值。`);
        record(name, rest ? rest.replace(/^=/, '') : args[++index]);
        break;
      }
    }
  }
  return { positionals, values };
}

const executeSchema = z.object({
  command: z.enum(Object.keys(catalog.commands)),
  arguments: z.array(z.string().max(MAX_ARGUMENT_LENGTH)
    .refine(value => !value.includes('\0'), '参数不能包含 NUL。')).max(100).default([]),
  dry_run: z.boolean().default(false),
  stdin: z.string().max(MAX_STDIN_BYTES)
    .refine(value => Buffer.byteLength(value, 'utf8') <= MAX_STDIN_BYTES,
      'stdin 的 UTF-8 编码不能超过 256 KiB。').optional(),
}).strict().superRefine(({ command, arguments: args, stdin }, context) => {
  if (args.reduce((length, arg) => length + arg.length, 0) > MAX_ARGUMENT_LENGTH) {
    context.addIssue({ code: 'custom', path: ['arguments'], message: '参数总长度不能超过 16384 个 UTF-16 码元。' });
    return;
  }
  try {
    const { positionals, values } = parseArguments(command, args);
    if (command === 'file download' && positionals[1] === '-') {
      throw new Error('file download 不能把原始字节写到标准输出；请指定本机路径，或使用 ugreen_read_file。');
    }
    if (command === 'ctl user create' && (values.get('password-stdin') !== true || stdin === undefined)) {
      throw new Error('创建用户必须同时提供 --password-stdin 和 stdin；密码不能放进命令行参数。');
    }
    if (['file tee', 'docker compose up'].includes(command) && stdin === undefined &&
      !values.has('content') && !values.has('from-file')) {
      throw new Error('此命令需要通过 --content、--from-file 或 stdin 提供内容。');
    }
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['arguments'], message: error.message });
  }
});

export function registerBusinessTools(tool) {
  tool('ugreen_cli_help', '离线查看官方 unc 业务命令组或子命令帮助，确认当前 CLI 的参数。不会访问 NAS，也不读取登录缓存。command 使用空格分隔的命令路径。',
    z.object({ command: z.enum(catalog.helpCommands) }).strict(),
    async ({ command }, options) => {
      const data = await options.run([...command.split(' '), '--help'], { raw: true });
      return { success: true, command, help: Buffer.isBuffer(data) ? data.toString('utf8') : String(data) };
    }, helpAnnotations, false);

  tool('ugreen_execute', '执行官方 unc 的完整 NAS 业务命令，权限由现有令牌和 NAS 固件决定。command 选择叶命令路径，arguments 是独立参数数组，不要包含 unc、命令路径或 shell 语法。先查询帮助和目标对象，再按用户授权操作；删除、覆盖、服务变更等先 dry_run 预演。需要确认门禁时显式传 --yes，已有授权无需重复询问。dry_run 默认 false；预演可能联网，成功不保证真实执行成功。流式请求最多 1800 秒；写操作超时或失败后先查状态，不自动重试。stdin 为 UTF-8 内容，创建用户仅用 --password-stdin 与 stdin 传密码。认证覆盖、输出重定向、调试和 CLI 本机管理命令不可用。',
    executeSchema,
    ({ command, arguments: args, dry_run, stdin }, options) => {
      const inherited = catalog.commands[command].inheritedFlags || [];
      return options.run([
        ...command.split(' '),
        ...(dry_run ? ['--dry-run'] : []),
        ...(inherited.includes('stream-timeout') ? [`--stream-timeout=${STREAM_TIMEOUT_SECONDS}`] : []),
        ...args,
      ], {
        timeoutMs: PROCESS_TIMEOUT_MS,
        ...(stdin === undefined ? {} : { input: Buffer.from(stdin, 'utf8') }),
      });
    }, executeAnnotations);
}
