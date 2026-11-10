import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.mjs';

const remote = '/volume1/share/report.txt';
const folder = '/volume1/share/archive';
const local = path.join(tmpdir(), 'ugreen-write-tests', 'report.txt');
const toolArguments = {
  ugreen_upload_file: { local_path: local, remote_path: remote },
  ugreen_create_directory: { path: folder },
  ugreen_create_file: { path: remote },
  ugreen_write_file: { path: remote, content: 'updated' },
  ugreen_copy_file: { source_path: remote, destination_directory: folder },
  ugreen_move_file: { source_path: remote, destination: folder },
  ugreen_delete_file: { path: remote },
  ugreen_restore_file: { recycle_path: '/volume1/share/#recycle/report.txt' },
};

async function connect(t, handler = async () => ({ success: true }), authenticated = true) {
  const calls = [];
  const server = createServer({ run: async (args, options = {}) => {
    calls.push({ args: [...args], options });
    if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
      return { success: true, authenticated, hint: authenticated ? undefined : 'Reconnect in WorkBuddy.' };
    }
    return handler(args, options);
  } });
  const client = new Client({ name: 'file-write-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

function body(result) {
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

function businessCalls(calls) {
  return calls.filter(call => !(call.args.length === 2 && call.args[0] === 'auth' && call.args[1] === 'status'));
}

async function invoke(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`);
  return result;
}

test('file write catalog exposes all eight tools with accurate mutation annotations', async t => {
  const { client, calls } = await connect(t);
  const { tools } = await client.listTools();
  const writes = tools.filter(tool => Object.hasOwn(toolArguments, tool.name));
  assert.deepEqual(writes.map(tool => tool.name).sort(), Object.keys(toolArguments).sort());
  for (const tool of writes) {
    assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    assert.equal(tool.annotations.destructiveHint,
      !['ugreen_create_directory', 'ugreen_restore_file'].includes(tool.name), tool.name);
    assert.equal(tool.annotations.idempotentHint,
      ['ugreen_create_directory', 'ugreen_create_file', 'ugreen_delete_file'].includes(tool.name), tool.name);
    assert.equal(tool.annotations.openWorldHint, true, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.equal(calls.length, 0, 'catalog discovery must not authenticate or contact a NAS');
});

test('upload has safe conflict defaults, explicit replace confirmation, and a matching large-file time budget', async t => {
  const { client, calls } = await connect(t);
  await invoke(client, 'ugreen_upload_file', toolArguments.ugreen_upload_file);
  assert.deepEqual(businessCalls(calls).at(-1).args, [
    'file', 'upload', local, remote, '--on-conflict', 'rename', '--stream-timeout', '1800',
  ]);
  for (const on_conflict of ['rename', 'skip', 'replace']) {
    for (const dry_run of [false, true]) {
      await invoke(client, 'ugreen_upload_file', {
        local_path: local, remote_path: remote, on_conflict, verify: true, dry_run,
      });
      const call = businessCalls(calls).at(-1);
      assert.deepEqual(call.args, [
        'file', 'upload', local, remote, '--on-conflict', on_conflict, '--verify', '--stream-timeout', '1800',
        ...(dry_run ? ['--dry-run'] : on_conflict === 'replace' ? ['--yes'] : []),
      ]);
      assert.equal(call.options.timeoutMs, 1830000);
      assert.ok(call.options.signal instanceof AbortSignal);
    }
  }
  const count = calls.length;
  for (const local_path of ['-', 'relative/file.txt', '\\\\.\\NUL', '\\\\?\\C:\\file.txt']) {
    const result = await client.callTool({ name: 'ugreen_upload_file', arguments: { local_path, remote_path: remote } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, count, 'invalid local paths must not authenticate or run upload');
});

test('directory creation preserves octal permissions and only creates parents when requested', async t => {
  const { client, calls } = await connect(t);
  await invoke(client, 'ugreen_create_directory', { path: folder });
  assert.deepEqual(businessCalls(calls).at(-1).args, ['file', 'mkdir', folder, '--mode', '0755']);
  await invoke(client, 'ugreen_create_directory', { path: folder, parents: true, mode: '0o2775', dry_run: true });
  assert.deepEqual(businessCalls(calls).at(-1).args, [
    'file', 'mkdir', folder, '--mode', '0o2775', '--parents', '--dry-run',
  ]);
  const count = calls.length;
  for (const mode of ['0788', 'u+rwx', '--yes', 'write', 755]) {
    const result = await client.callTool({ name: 'ugreen_create_directory', arguments: { path: folder, mode } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, count);
});

test('file creation defaults to exclusive empty creation and encodes UTF-8 content losslessly', async t => {
  const { client, calls } = await connect(t);
  await invoke(client, 'ugreen_create_file', { path: remote });
  assert.deepEqual(businessCalls(calls).at(-1).args, [
    'file', 'touch', remote, '--content', '', '--base64', '--mode', '0644', '--exclusive',
  ]);
  const content = '中文\n\0\'"`$(test); --token synthetic-text';
  await invoke(client, 'ugreen_create_file', {
    path: remote, content, exclusive: false, mode: '0640', dry_run: true,
  });
  const call = businessCalls(calls).at(-1);
  assert.deepEqual(call.args, [
    'file', 'touch', remote, '--content', Buffer.from(content, 'utf8').toString('base64'),
    '--base64', '--mode', '0640', '--dry-run',
  ]);
  assert.equal(call.args.includes('--yes'), false);
  assert.equal(call.args.includes('--exclusive'), false);
  assert.equal(Buffer.from(call.args[4], 'base64').toString('utf8'), content);
  await invoke(client, 'ugreen_create_file', { path: remote, content: 'x'.repeat(16384) });
  const count = calls.length;
  for (const content of ['x'.repeat(16385), '中'.repeat(5462)]) {
    const result = await client.callTool({ name: 'ugreen_create_file', arguments: { path: remote, content } });
    assert.equal(result.isError, true, 'create content limit is UTF-8 bytes, not JS character count');
  }
  const result = await client.callTool({ name: 'ugreen_create_file', arguments: { path: remote, mode: '0649' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, count);
});

test('write, append and patch pass exact UTF-8 bytes on stdin and keep content out of argv', async t => {
  const { client, calls } = await connect(t);
  const content = '中文\0\n\'"`$(); --token synthetic-file-content';
  for (const mode of ['write', 'append', 'patch']) {
    for (const dry_run of [false, true]) {
      const offset = mode === 'patch' ? 17 : undefined;
      await invoke(client, 'ugreen_write_file', { path: remote, content, mode, ...(offset === undefined ? {} : { offset }), dry_run });
      const call = businessCalls(calls).at(-1);
      assert.deepEqual(call.args, [
        'file', 'tee', remote, '--mode', mode, ...(offset === undefined ? [] : ['--offset', '17']),
        dry_run ? '--dry-run' : '--yes',
      ]);
      assert.ok(Buffer.isBuffer(call.options.input));
      assert.deepEqual(call.options.input, Buffer.from(content, 'utf8'));
      assert.equal(call.options.input.length, Buffer.byteLength(content, 'utf8'));
      assert.equal(call.args.some(arg => arg.includes('synthetic-file-content')), false);
      assert.equal(call.args.includes('--content'), false);
      assert.equal(call.args.includes('--from-file'), false);
      assert.ok(call.options.signal instanceof AbortSignal);
    }
  }
  await invoke(client, 'ugreen_write_file', { path: remote, content: 'x'.repeat(262144) });
  assert.equal(businessCalls(calls).at(-1).options.input.length, 262144);
  await invoke(client, 'ugreen_write_file', { path: remote, content: '' });
  assert.equal(businessCalls(calls).at(-1).options.input.length, 0, 'empty overwrite remains a valid write');
});

test('write schema rejects excessive UTF-8 bytes, invalid patch offsets and injected options before authentication', async t => {
  const { client, calls } = await connect(t);
  const invalid = [
    { content: 'x'.repeat(262145) },
    { content: '中'.repeat(87382) },
    { content: 'x', mode: 'patch' },
    { content: 'x', mode: 'patch', offset: -1 },
    { content: 'x', mode: 'patch', offset: 1.5 },
    { content: 'x', mode: 'patch', offset: Number.MAX_SAFE_INTEGER + 1 },
    { content: 'x', offset: 0 },
    { content: 'x', mode: 'append', offset: 0 },
    { content: 'x', mode: '0644' },
    { content: 'x', token: 'synthetic-injection' },
  ];
  for (const args of invalid) {
    const result = await client.callTool({ name: 'ugreen_write_file', arguments: { path: remote, ...args } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test('copy and move keep destination-directory semantics and use only their actual CLI confirmation gates', async t => {
  const { client, calls } = await connect(t);
  for (const on_conflict of ['rename', 'skip', 'replace']) {
    for (const dry_run of [false, true]) {
      await invoke(client, 'ugreen_copy_file', { source_path: remote, destination_directory: folder, on_conflict, dry_run });
      assert.deepEqual(businessCalls(calls).at(-1).args, [
        'file', 'cp', remote, folder, '--on-conflict', on_conflict, ...(dry_run ? ['--dry-run'] : []),
      ]);
      await invoke(client, 'ugreen_move_file', { source_path: remote, destination: folder, on_conflict, dry_run });
      assert.deepEqual(businessCalls(calls).at(-1).args, [
        'file', 'mv', remote, folder, '--on-conflict', on_conflict, dry_run ? '--dry-run' : '--yes',
      ]);
    }
  }
  await invoke(client, 'ugreen_move_file', { source_path: remote, destination: '改名后的报告.txt' });
  assert.deepEqual(businessCalls(calls).at(-1).args, [
    'file', 'mv', remote, '改名后的报告.txt', '--on-conflict', 'rename', '--yes',
  ]);
  const count = calls.length;
  const invalid = [
    ['ugreen_copy_file', { source_path: remote, destination_directory: 'new.txt' }],
    ['ugreen_move_file', { source_path: remote, destination: 'relative/new.txt' }],
    ['ugreen_move_file', { source_path: remote, destination: 'relative\\new.txt' }],
    ['ugreen_move_file', { source_path: remote, destination: '--yes' }],
    ['ugreen_move_file', { source_path: remote, destination: '.' }],
    ['ugreen_move_file', { source_path: remote, destination: '..' }],
    ['ugreen_copy_file', { source_path: remote, destination_directory: folder, on_conflict: 'overwrite' }],
  ];
  for (const [name, args] of invalid) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.equal(calls.length, count, 'copy cannot rename and move rejects relative paths or injected filenames');
});

test('nonrecursive delete rejects directories and unknown types without sending an rm request', async t => {
  let type = 'FILE_TYPE_DIR';
  const { client, calls } = await connect(t, async args => {
    assert.equal(args[1], 'stat', 'a refused nonrecursive delete must never invoke rm');
    return { success: true, items: [{ success: true, data: { stat: { type } } }] };
  });
  for (const candidate of ['FILE_TYPE_DIR', 'FILE_TYPE_OTHER', 'FILE_TYPE_UNSPECIFIED', undefined]) {
    type = candidate;
    for (const dry_run of [false, true]) {
      const result = await client.callTool({ name: 'ugreen_delete_file', arguments: { path: remote, dry_run } });
      assert.equal(result.isError, true);
      assert.equal(body(result).success, false);
    }
  }
  assert.equal(businessCalls(calls).length, 8);
  assert.ok(businessCalls(calls).every(call => call.args[1] === 'stat'));
});

test('delete protects nonrecursive files, defaults to recycle and only adds permanent when explicitly requested', async t => {
  let type = 'FILE_TYPE_FILE';
  const receipt = { success: true, items: [{ path: remote, success: true, data: {
    receipt: { final_path: '/volume1/share/#recycle/report.txt' },
  } }] };
  const { client, calls } = await connect(t, async args => args[1] === 'stat' ? {
    success: true, items: [{ success: true, data: { stat: { type } } }],
  } : receipt);
  for (const recursive of [false, true]) {
    for (const permanent of [false, true]) {
      for (const dry_run of [false, true]) {
        const start = calls.length;
        const result = await invoke(client, 'ugreen_delete_file', { path: remote, recursive, permanent, dry_run });
        assert.deepEqual(body(result), receipt, 'retain the official recycle receipt for later restore');
        const expected = recursive ? [] : [['file', 'stat', remote]];
        expected.push(['file', 'rm', remote, ...(permanent ? ['--permanent'] : []), dry_run ? '--dry-run' : '--yes']);
        assert.deepEqual(businessCalls(calls.slice(start)).map(call => call.args), expected);
        assert.ok(!businessCalls(calls.slice(start)).at(-1).args.includes('--recursive'), 'unc rm has no recursive flag');
      }
    }
  }
  type = 'FILE_TYPE_SYMLINK';
  await invoke(client, 'ugreen_delete_file', { path: remote });
  assert.deepEqual(businessCalls(calls).at(-1).args, ['file', 'rm', remote, '--yes']);
});

test('restore forwards the exact returned recycle path and never adds an unnecessary yes flag', async t => {
  const { client, calls } = await connect(t);
  const recycle_path = '/volume1/share/#recycle/中文 report; $(text).txt';
  for (const dry_run of [false, true]) {
    await invoke(client, 'ugreen_restore_file', { recycle_path, dry_run });
    assert.deepEqual(businessCalls(calls).at(-1).args, [
      'file', 'recover-recycle', recycle_path, ...(dry_run ? ['--dry-run'] : []),
    ]);
  }
  const count = calls.length;
  assert.equal((await client.callTool({ name: 'ugreen_restore_file', arguments: { recycle_path: 'relative/file' } })).isError, true);
  assert.equal(calls.length, count);
});

test('failed authentication prevents every file mutation', async t => {
  const { client, calls } = await connect(t, async () => assert.fail('business command invoked without authentication'), false);
  for (const [name, args] of Object.entries(toolArguments)) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(body(result).hint, 'Reconnect in WorkBuddy.');
  }
  assert.equal(calls.length, 8);
  assert.equal(businessCalls(calls).length, 0);
});

test('failed file mutations are never retried and preserve structured permission and compatibility details', async t => {
  const details = { success: false,
    error_detail: { subtype: 'permission_denied', method: '/filesystem/WriteFile' },
    compatibility_hint: { signal: 'method_unavailable' }, warnings: ['Keep the original diagnostic.'],
    access_token: 'synthetic-secret',
  };
  const { client, calls } = await connect(t, async args => {
    if (args[1] === 'stat') return { success: true, items: [{ success: true, data: { stat: { type: 'FILE_TYPE_FILE' } } }] };
    const error = new Error('Write failed: Bearer synthetic-secret');
    error.details = details;
    throw error;
  });
  for (const [name, args] of Object.entries(toolArguments)) {
    const start = calls.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const value = body(result);
    assert.deepEqual(value.details.error_detail, details.error_detail);
    assert.deepEqual(value.details.compatibility_hint, details.compatibility_hint);
    assert.deepEqual(value.details.warnings, details.warnings);
    assert.equal(value.details.access_token, '[REDACTED]');
    assert.equal(value.error, 'Write failed: Bearer [REDACTED]');
    const mutations = businessCalls(calls.slice(start)).filter(call => call.args[1] !== 'stat');
    assert.equal(mutations.length, 1, `${name} must not resubmit a failed write`);
  }
});
