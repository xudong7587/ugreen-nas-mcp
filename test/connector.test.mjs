import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.mjs';
import { uncEnvironment } from '../lib/unc.mjs';

async function connect(t, handler = async () => ({ success: true })) {
  const calls = [];
  const server = createServer({
    run: async (args, options = {}) => {
      calls.push({ args: [...args], options });
      if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
        return { success: true, authenticated: true };
      }
      return handler(args, options);
    },
  });
  const client = new Client({ name: 'connector-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, calls };
}

function value(result) {
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

async function invalid(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should reject invalid arguments`);
}

test('the catalog exposes query and mutation tools with accurate read/write annotations', async t => {
  const { client, calls } = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'ugreen_cli_help', 'ugreen_copy_file', 'ugreen_create_directory', 'ugreen_create_file', 'ugreen_delete_file',
    'ugreen_connection_status', 'ugreen_download_file', 'ugreen_file_stat',
    'ugreen_execute', 'ugreen_list_files', 'ugreen_move_file', 'ugreen_nas_info', 'ugreen_read_file',
    'ugreen_restore_file', 'ugreen_search', 'ugreen_search_results', 'ugreen_upload_file', 'ugreen_write_file',
  ].sort());
  const readOnlyTools = new Set(['ugreen_cli_help', 'ugreen_connection_status', 'ugreen_file_stat',
    'ugreen_list_files', 'ugreen_nas_info', 'ugreen_read_file', 'ugreen_search', 'ugreen_search_results']);
  const destructiveTools = new Set(['ugreen_execute', 'ugreen_copy_file', 'ugreen_create_file',
    'ugreen_delete_file', 'ugreen_move_file', 'ugreen_upload_file', 'ugreen_write_file']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, readOnlyTools.has(tool.name), tool.name);
    assert.equal(tool.annotations.destructiveHint, destructiveTools.has(tool.name), tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.equal(calls.length, 0, 'discovering tools must not contact the NAS');
});

test('connection status checks the network by default and supports a local-only check', async t => {
  const { client, calls } = await connect(t, async () => ({ success: true, authenticated: true }));
  await client.callTool({ name: 'ugreen_connection_status', arguments: {} });
  await client.callTool({ name: 'ugreen_connection_status', arguments: { check: false } });
  assert.deepEqual(calls.map(call => call.args), [
    ['auth', 'status', '--check'], ['auth', 'status'],
  ]);
});

test('listing defaults to shared roots and preserves the actual CLI envelope', async t => {
  const official = { success: true, action: '/filesystem/List', data: { data: {
    file_list: { files: [{ path: '/volume1/share', name: 'share' }], total: 1 },
  } } };
  const { client, calls } = await connect(t, async () => official);
  const result = await client.callTool({ name: 'ugreen_list_files', arguments: {} });
  assert.deepEqual(value(result), official);
  assert.deepEqual(calls.map(call => call.args), [
    ['auth', 'status'],
    ['file', 'ls-root', '--root', 'shared', '--limit', '100', '--page', '0', '--sort', 'name'],
  ]);
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
});

test('a valid path containing spaces and shell punctuation stays one CLI argument', async t => {
  const { client, calls } = await connect(t);
  const folder = '/volume1/share/a; --token fake $(echo x)';
  await client.callTool({ name: 'ugreen_list_files', arguments: {
    path: folder, limit: 20, page: 2, sort: 'mtime', reverse: true,
  } });
  assert.deepEqual(calls[1].args, [
    'file', 'ls-root', folder, '--limit', '20', '--page', '2', '--sort', 'mtime', '--reverse',
  ]);
});

test('invalid or injected options are rejected before any CLI call', async t => {
  const { client, calls } = await connect(t);
  const cases = [
    ['ugreen_connection_status', { token: 'fake' }],
    ['ugreen_list_files', { path: '--token=fake' }],
    ['ugreen_list_files', { root: 'shared', output: 'outside.json' }],
    ['ugreen_list_files', { limit: 501 }],
    ['ugreen_file_stat', { path: 'relative/path' }],
    ['ugreen_read_file', { path: '/share/a', length: 262145 }],
    ['ugreen_read_file', { path: '/share/a', offset: -1 }],
    ['ugreen_search', { query: '--server-url=https://untrusted.invalid' }],
    ['ugreen_search', { query: 'a\0b' }],
    ['ugreen_search', { query: 'report', suffix: 'pdf --token=fake' }],
    ['ugreen_search_results', { task_id: '--help' }],
    ['ugreen_nas_info', { section: 'restart' }],
  ];
  for (const [name, args] of cases) await invalid(client, name, args);
  assert.equal(calls.length, 0);
});

test('failed authentication prevents all business operations', async t => {
  const calls = [];
  const server = createServer({ run: async args => {
    calls.push([...args]);
    return { success: true, authenticated: false, hint: 'Reconnect in WorkBuddy.' };
  } });
  const client = new Client({ name: 'unauthenticated-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'ugreen_file_stat', arguments: { path: '/share/file' } });
  assert.equal(result.isError, true);
  assert.equal(value(result).hint, 'Reconnect in WorkBuddy.');
  assert.deepEqual(calls, [['auth', 'status']]);
});

test('structured CLI failures survive the MCP boundary while credentials are redacted', async t => {
  const details = {
    success: false,
    error_detail: { subtype: 'compat_method_not_provided', recommended_action: 'update_component' },
    compatibility_hint: { signal: 'method_unavailable' },
    warnings: ['Keep this diagnostic warning.'],
    access_token: 'synthetic-secret',
  };
  const { client } = await connect(t, async () => {
    const error = new Error('Request failed: Bearer synthetic-secret');
    error.details = details;
    throw error;
  });
  const result = await client.callTool({ name: 'ugreen_file_stat', arguments: { path: '/share/file' } });
  assert.equal(result.isError, true);
  const body = value(result);
  assert.deepEqual(body.details.error_detail, details.error_detail);
  assert.deepEqual(body.details.compatibility_hint, details.compatibility_hint);
  assert.deepEqual(body.details.warnings, details.warnings);
  assert.equal(body.details.access_token, '[REDACTED]');
  assert.equal(body.error, 'Request failed: Bearer [REDACTED]');
});

test('partial CLI failures are surfaced as MCP errors', async t => {
  const official = { success: true, items: [{ success: false, error: 'Permission denied.' }] };
  const { client } = await connect(t, async () => official);
  const result = await client.callTool({ name: 'ugreen_file_stat', arguments: { path: '/share/file' } });
  assert.equal(result.isError, true);
  assert.deepEqual(value(result), official);
});

test('bounded file reads retain bytes and expose an offset for continuation', async t => {
  const bytes = Buffer.from([0xff, 0x00, 0x61]);
  const { client, calls } = await connect(t, async () => bytes);
  const result = await client.callTool({ name: 'ugreen_read_file', arguments: {
    path: '/share/binary', offset: 7, length: 3, encoding: 'base64',
  } });
  assert.deepEqual(calls[1].args, [
    'file', 'cat', '/share/binary', '--offset', '7', '--length', '3', '--chunk-size', '3',
  ]);
  assert.equal(calls[1].options.raw, true);
  const body = value(result);
  assert.equal(body.content, bytes.toString('base64'));
  assert.equal(body.bytes_read, 3);
  assert.equal(body.next_offset, 10);
  assert.equal(body.may_have_more, true);
});

test('a UTF-8 character cut at the read boundary falls back to lossless base64', async t => {
  const bytes = Buffer.from('中', 'utf8').subarray(0, 2);
  const { client } = await connect(t, async () => bytes);
  const result = await client.callTool({ name: 'ugreen_read_file', arguments: {
    path: '/share/text', offset: 7, length: 2,
  } });
  assert.notEqual(result.isError, true);
  const body = value(result);
  assert.equal(body.success, true);
  assert.equal(body.encoding, 'base64');
  assert.equal(body.requested_encoding, 'utf8');
  assert.deepEqual(Buffer.from(body.content, 'base64'), bytes);
  assert.equal(body.bytes_read, 2);
  assert.equal(body.next_offset, 9);
  assert.equal(body.may_have_more, true);
  assert.equal(typeof body.note, 'string');
  assert.ok(body.note.length > 0);
});

test('binary bytes requested as UTF-8 remain available without replacement characters', async t => {
  const bytes = Buffer.from([0xff, 0x00, 0x61]);
  const { client } = await connect(t, async () => bytes);
  const result = await client.callTool({ name: 'ugreen_read_file', arguments: { path: '/share/binary' } });
  assert.notEqual(result.isError, true);
  const body = value(result);
  assert.equal(body.encoding, 'base64');
  assert.equal(body.requested_encoding, 'utf8');
  assert.deepEqual(Buffer.from(body.content, 'base64'), bytes);
  assert.equal(body.next_offset, bytes.length);
  assert.equal(body.may_have_more, false);
});

test('CLI environment removes credential overrides in any case and preserves other variables', () => {
  const source = Object.freeze({
    UNC_NAS_TOKEN: 'synthetic-uppercase-token',
    unc_nas_token: 'synthetic-lowercase-token',
    UnC_NaS_ToKeN: 'synthetic-mixedcase-token',
    UNC_NAS_URL: 'https://synthetic.invalid',
    unc_nas_url: 'https://synthetic-lowercase.invalid',
    UnC_NaS_InSeCuRe: 'true',
    UNC_NAS_INSECURE: '1',
    Path: 'C:\\safe-bin',
    USERPROFILE: 'C:\\Users\\Test',
    UGREEN_UNC_BIN: 'C:\\safe-bin\\unc.exe',
    UNC_NAS_TOKEN_EXTRA: 'keep-an-unrelated-setting',
    UNC_OTHER_SETTING: 'keep-another-setting',
  });
  const before = { ...source };
  const result = uncEnvironment(source);
  assert.deepEqual(result, {
    Path: 'C:\\safe-bin',
    USERPROFILE: 'C:\\Users\\Test',
    UGREEN_UNC_BIN: 'C:\\safe-bin\\unc.exe',
    UNC_NAS_TOKEN_EXTRA: 'keep-an-unrelated-setting',
    UNC_OTHER_SETTING: 'keep-another-setting',
  });
  assert.deepEqual(source, before, 'filtering must not mutate the parent environment');
});

test('search and continuation use consistent sorting and retain pagination data', async t => {
  const official = { success: true, data: { task_id: 'task-123', next_offset: 50, task_removed: false } };
  const { client, calls } = await connect(t, async () => official);
  const result = await client.callTool({ name: 'ugreen_search', arguments: {
    query: 'annual report; $(echo x)', path: '/share/docs', suffix: 'pdf',
  } });
  assert.deepEqual(value(result), official);
  await client.callTool({ name: 'ugreen_search_results', arguments: { task_id: 'task-123', offset: 50 } });
  assert.deepEqual(calls[1].args, [
    'search', 'title', 'annual report; $(echo x)', '--path', '/share/docs', '-R', '--suffix', 'pdf',
    '--limit', '50', '--sort-by', 'name', '--order', 'asc', '--stream-timeout', '120',
  ]);
  assert.deepEqual(calls[3].args, [
    'search', 'results', 'task-123', '--offset', '50', '--limit', '50', '--sort-by', 'name', '--order', 'asc',
  ]);
});

test('download requires an absolute local path and never adds overwrite flags', async t => {
  const { client, calls } = await connect(t);
  const destination = path.join(tmpdir(), 'ugreen-connector-test', 'report.pdf');
  await client.callTool({ name: 'ugreen_download_file', arguments: {
    remote_path: '/share/report.pdf', local_path: destination,
  } });
  assert.deepEqual(calls[1].args, [
    'file', 'download', '/share/report.pdf', destination, '--stream-timeout', '120',
  ]);
  const before = calls.length;
  for (const local_path of ['-', 'relative/report.pdf', '\\\\.\\NUL', '\\\\?\\C:\\report.pdf']) {
    await invalid(client, 'ugreen_download_file', { remote_path: '/share/report.pdf', local_path });
  }
  await invalid(client, 'ugreen_download_file', {
    remote_path: '/share/report.pdf', local_path: destination, force: true,
  });
  assert.equal(calls.length, before, 'invalid destinations must not reach the CLI');
  assert.ok(!calls[1].args.includes('--force'));
  assert.ok(!calls[1].args.includes('--continue'));
});

test('NAS information sections map to a fixed set of query commands', async t => {
  const { client, calls } = await connect(t);
  const commands = {
    volumes: ['storage', 'volume', 'ls'], pools: ['storage', 'pool', 'ls'], disks: ['storage', 'disk', 'ls'],
    containers: ['docker', 'ps', '--page-size', '100'], images: ['docker', 'images'], compose: ['docker', 'compose', 'ls'],
    apps: ['app', 'ls', '--installed'], overview: ['taskmgr', 'overview'],
    processes: ['taskmgr', 'process', 'ls', '--sort', 'cpu', '--top', '20'],
    services: ['taskmgr', 'service', 'ls', '--sort', 'cpu', '--top', '20'],
  };
  for (const [section, expected] of Object.entries(commands)) {
    const start = calls.length;
    await client.callTool({ name: 'ugreen_nas_info', arguments: { section } });
    assert.deepEqual(calls.slice(start).map(call => call.args), [['auth', 'status'], expected]);
  }
});
