import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.mjs';
import catalog from '../lib/cli-commands.json' with { type: 'json' };

async function connect(t, { authenticated = true, handler = async () => ({ success: true }) } = {}) {
  const calls = [];
  const server = createServer({ run: async (args, options = {}) => {
    calls.push({ args: [...args], options });
    if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
      return { success: true, authenticated, hint: 'Reconnect in WorkBuddy.' };
    }
    return handler(args, options);
  } });
  const client = new Client({ name: 'business-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

function body(result) {
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, value);
  return value;
}

async function execute(client, command, args = [], extra = {}) {
  return client.callTool({ name: 'ugreen_execute', arguments: { command, arguments: args, ...extra } });
}

test('the public catalog contains the verified official business tree and conservative annotations', async t => {
  const { client, calls } = await connect(t);
  const { tools } = await client.listTools();
  const help = tools.find(tool => tool.name === 'ugreen_cli_help');
  const command = tools.find(tool => tool.name === 'ugreen_execute');
  assert.equal(catalog.cliVersion, '0.1.61');
  assert.equal(Object.keys(catalog.commands).length, 99);
  assert.equal(catalog.helpCommands.length, 122);
  assert.deepEqual(command.inputSchema.properties.command.enum, Object.keys(catalog.commands));
  assert.deepEqual(help.inputSchema.properties.command.enum, catalog.helpCommands);
  assert.equal(help.annotations.readOnlyHint, true);
  assert.equal(help.annotations.openWorldHint, false);
  assert.equal(command.annotations.readOnlyHint, false);
  assert.equal(command.annotations.destructiveHint, true);
  assert.equal(command.annotations.idempotentHint, false);
  assert.equal(calls.length, 0);
});

test('help is offline and works without an authenticated NAS', async t => {
  const text = 'Usage:\n  unc file tee PATH [flags]\n';
  const { client, calls } = await connect(t, {
    authenticated: false,
    handler: async () => Buffer.from(text),
  });
  const result = await client.callTool({ name: 'ugreen_cli_help', arguments: { command: 'file tee' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(body(result), { success: true, command: 'file tee', help: text });
  assert.deepEqual(calls.map(call => call.args), [['file', 'tee', '--help']]);
  assert.equal(calls[0].options.raw, true);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('generic queries cover all business modules and preserve official JSON and pagination', async t => {
  const official = { success: true, data: { next_offset: 100, count: '9007199254740993' } };
  const { client, calls } = await connect(t, { handler: async () => official });
  const queries = [
    ['file quota get', ['/share/docs']], ['docker ps', ['--page-size', '50']],
    ['download ls', []], ['app get', ['com.ugreen.photos']],
    ['ctl hardware power', []], ['storage disk ls', ['--lang', 'zh-CN']],
    ['network iface ls', ['eth0']], ['taskmgr overview', []],
    ['search results', ['task-123', '--offset', '50']], ['doctor', ['--offline']],
  ];
  for (const [command, args] of queries) {
    const start = calls.length;
    const result = await execute(client, command, args);
    assert.notEqual(result.isError, true, command);
    assert.deepEqual(body(result), official);
    assert.deepEqual(calls[start].args, ['auth', 'status']);
    const forwarded = calls[start + 1];
    assert.deepEqual(forwarded.args.slice(0, command.split(' ').length), command.split(' '));
    assert.deepEqual(forwarded.args.slice(-args.length || forwarded.args.length), args);
    assert.equal(forwarded.options.timeoutMs, 1830000);
    assert.ok(forwarded.options.signal instanceof AbortSignal);
    assert.equal(forwarded.args.includes('--yes'), false);
    assert.equal(forwarded.args.includes('--dry-run'), false);
    assert.equal(calls.length, start + 2);
  }
});

test('writes from each writable module reach the official CLI with the requested confirmation flags', async t => {
  const { client, calls } = await connect(t);
  const writes = [
    ['file tag add', ['important']],
    ['file quota set', ['/share/docs', '--quota-mb', '1024', '--yes']],
    ['docker pull', ['nginx:latest']],
    ['docker start', ['container-1', '--yes']],
    ['docker compose up', ['--name', 'blog', '--path', '/share/docker/blog', '--content', 'services: {}', '--yes']],
    ['docker compose delete', ['blog', '--delete-images', '--yes']],
    ['download create', ['https://example.invalid/file.zip', '--dir', '/share/downloads']],
    ['download rm', ['task-1', '--yes']],
    ['app install', ['com.example.app', '--path', '/volume1', '--yes']],
    ['app uninstall', ['com.example.app', '--clean', '--yes']],
    ['app start', ['com.example.app', '--yes']],
    ['ctl group add-member', ['1000', '1001:bob', '--yes']],
    ['search cancel', ['task-1']], ['search rm', ['task-1']],
  ];
  for (const [command, args] of writes) {
    const start = calls.length;
    const result = await execute(client, command, args);
    assert.notEqual(result.isError, true, command);
    assert.equal(calls.length, start + 2, command);
    assert.deepEqual(calls[start + 1].args.slice(-args.length), args);
  }
});

test('protected options and unknown flags are rejected before even checking authentication', async t => {
  const { client, calls } = await connect(t);
  const unsafe = [
    ['--token', 'synthetic-secret'], ['--token=synthetic-secret'],
    ['--server-url=https://untrusted.invalid'], ['--client-id=synthetic'],
    ['--client-secret', 'synthetic-secret'], ['--output=out.json'], ['-oout.json'], ['-yoout.json'],
    ['--format=raw'], ['-fraw'], ['-yfraw'], ['--debug=false'], ['--verbose=false'], ['-yv'],
    ['--help'], ['-yh'], ['--dry-run=false'], ['--timeout=0'], ['--insecure'],
    ['--unknown'], ['--TOKEN=synthetic-secret'], ['---token=synthetic-secret'],
    ['--on-conflict'],
  ];
  for (const args of unsafe) {
    const result = await execute(client, 'file mv', ['/share/a', 'b', ...args]);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test('protected words stay literal when consumed as option values, content, paths, or post-terminator arguments', async t => {
  const { client, calls } = await connect(t);
  const safeContent = [
    ['--content', '--token'], ['--content=--token'],
    ['--content', '--format=raw'], ['--content', 'a; --token fake $(echo x)'],
  ];
  for (const args of safeContent) {
    const result = await execute(client, 'file tee', ['/share/file; --token fake', ...args, '--yes']);
    assert.notEqual(result.isError, true, JSON.stringify(args));
    assert.deepEqual(calls.at(-1).args.slice(-args.length - 2), ['/share/file; --token fake', ...args, '--yes']);
  }
  const args = ['-y', '--', '/share/a', '--token'];
  const result = await execute(client, 'file mv', args);
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.at(-1).args.slice(-args.length), args);
});

test('dry-run and stream limits precede the terminator while global runner options remain usable before the command', async t => {
  const { client, calls } = await connect(t);
  const result = await execute(client, 'file mv', ['--', '/share/a', '--token'], { dry_run: true });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls[1].args, [
    'file', 'mv', '--dry-run', '--stream-timeout=1800', '--', '/share/a', '--token',
  ]);
  // runUnc prefixes its forced --format/--timeout before this vector. The
  // terminator therefore cannot turn either runner option into a NAS filename.
  assert.equal(calls[1].args.includes('--format'), false);
  assert.equal(calls[1].args.includes('--timeout'), false);
  assert.equal(calls[1].options.timeoutMs, 1830000);
});

test('stdin carries UTF-8 content and user passwords through a pipe rather than argv', async t => {
  const { client, calls } = await connect(t);
  const password = 'synthetic-only-password';
  const result = await execute(client, 'ctl user create', ['bob', '--password-stdin', '--yes'], { stdin: password });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls[1].options.input, Buffer.from(password));
  assert.equal(calls[1].args.some(arg => arg.includes(password)), false);
  assert.equal(JSON.stringify(body(result)).includes(password), false);
  await execute(client, 'docker compose up', ['--name', 'blog', '--path', '/share/blog', '--yes'], { stdin: 'services: {}' });
  assert.deepEqual(calls.at(-1).options.input, Buffer.from('services: {}'));
  await execute(client, 'file tee', ['/share/a', '--yes'], { stdin: '中文内容' });
  assert.deepEqual(calls.at(-1).options.input, Buffer.from('中文内容', 'utf8'));
  const before = calls.length;
  for (const [command, args, extra] of [
    ['ctl user create', ['bob', '--yes'], { stdin: password }],
    ['ctl user create', ['bob', '--password-stdin', '--yes'], {}],
    ['ctl user create', ['bob', '--password', password, '--yes'], {}],
    ['file tee', ['/share/a', '--yes'], {}],
    ['docker compose up', ['--name', 'blog', '--path', '/share/blog', '--yes'], {}],
  ]) assert.equal((await execute(client, command, args, extra)).isError, true, command);
  assert.equal(calls.length, before);
});

test('stream budgets, aggregate argument size, NULs, and UTF-8 stdin bytes are validated locally', async t => {
  const { client, calls } = await connect(t);
  await execute(client, 'file ls', ['/share', '--stream-timeout', '1']);
  assert.equal(calls.at(-1).args.at(-1), '1');
  await execute(client, 'file ls', ['/share', '--stream-timeout=1800']);
  assert.equal(calls.at(-1).args.at(-1), '--stream-timeout=1800');
  const boundaryInput = 'x'.repeat(262144);
  const boundary = await execute(client, 'file tee', ['/share/a', '--yes'], { stdin: boundaryInput });
  assert.notEqual(boundary.isError, true);
  assert.equal(calls.at(-1).options.input.length, 262144);
  const before = calls.length;
  for (const args of [
    ['/share', '--stream-timeout=0'], ['/share', '--stream-timeout=-1'],
    ['/share', '--stream-timeout=1801'], ['/share', '--stream-timeout=1.5'],
    ['/share', '--stream-timeout'], ['/share\0bad'],
    Array(101).fill('/share'), ['a'.repeat(9000), 'b'.repeat(9000)],
  ]) assert.equal((await execute(client, 'file ls', args)).isError, true);
  assert.equal((await execute(client, 'file tee', ['/share/a'], { stdin: '你'.repeat(87382) })).isError, true);
  assert.equal((await execute(client, 'file tee', ['/share/a'], { stdin: 'x'.repeat(262145) })).isError, true);
  assert.equal(calls.length, before);
});

test('raw stdout downloads and non-business command paths are rejected without a CLI call', async t => {
  const { client, calls } = await connect(t);
  for (const args of [
    ['/share/file', '-'], ['--offset', '10', '/share/file', '-'], ['--', '/share/file', '-'],
  ]) assert.equal((await execute(client, 'file download', args)).isError, true);
  for (const command of [
    'auth status', 'auth export', 'plugin install', 'skill setup', 'upgrade', 'uninstall',
    'help', 'version', 'completion', 'file', 'docker compose', 'file rm; auth logout', 'file unknown',
  ]) assert.equal((await execute(client, command)).isError, true, command);
  for (const command of ['auth', 'upgrade', 'file unknown']) {
    const result = await client.callTool({ name: 'ugreen_cli_help', arguments: { command } });
    assert.equal(result.isError, true, command);
  }
  assert.equal(calls.length, 0);
});

test('expired authentication blocks writes while structured CLI failures are returned once without retry', async t => {
  const loggedOut = await connect(t, { authenticated: false });
  const result = await execute(loggedOut.client, 'app uninstall', ['com.example.app', '--yes']);
  assert.equal(result.isError, true);
  assert.equal(body(result).hint, 'Reconnect in WorkBuddy.');
  assert.deepEqual(loggedOut.calls.map(call => call.args), [['auth', 'status']]);

  const details = {
    success: false, error_detail: { subtype: 'permission_denied', method: '/example/Write' },
    compatibility_hint: { signal: 'method_unavailable' }, warnings: ['Keep the official warning.'],
    token: 'synthetic-secret',
  };
  const failed = await connect(t, { handler: async () => {
    const error = new Error('Request failed: Bearer synthetic-secret');
    error.details = details;
    throw error;
  } });
  const failure = await execute(failed.client, 'app uninstall', ['com.example.app', '--yes']);
  assert.equal(failure.isError, true);
  const value = body(failure);
  assert.deepEqual(value.details.error_detail, details.error_detail);
  assert.deepEqual(value.details.compatibility_hint, details.compatibility_hint);
  assert.deepEqual(value.details.warnings, details.warnings);
  assert.equal(value.details.token, '[REDACTED]');
  assert.equal(value.error, 'Request failed: Bearer [REDACTED]');
  assert.deepEqual(failed.calls.map(call => call.args), [
    ['auth', 'status'], ['app', 'uninstall', 'com.example.app', '--yes'],
  ]);
});
