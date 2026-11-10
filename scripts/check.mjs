import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'ugreen-install-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['ugreen_upload_file', 'ugreen_write_file', 'ugreen_delete_file', 'ugreen_execute']) {
    if (!tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint === false)) {
      throw new Error(`写工具未正确加载：${name}`);
    }
  }
  const statusResult = await client.callTool({ name: 'ugreen_connection_status', arguments: { check: true } });
  const status = JSON.parse(statusResult.content[0].text);
  if (statusResult.isError || !status.authenticated || status.opencli?.connected !== true) {
    throw new Error('NAS 连通性检查失败，请运行 ugreen_connection_status 查看原因。');
  }
  const roots = {};
  for (const root of ['personal', 'shared']) {
    const result = await client.callTool({ name: 'ugreen_list_files', arguments: { root, limit: 100 } });
    if (result.isError) throw new Error(`无法列出 ${root} 根目录。`);
    const value = JSON.parse(result.content[0].text);
    const list = value.data?.data?.file_list;
    if (!Array.isArray(list?.files)) throw new Error('CLI 返回的目录结构与当前接口不兼容。');
    roots[root] = { returned: list.files.length, total: list.total };
  }
  // Deliberately report counts only; keep NAS names, paths and credentials out of logs.
  console.log(JSON.stringify({ mcp: 'ok', tools: tools.length,
    write_capable_tools: tools.filter(tool => tool.annotations?.readOnlyHint === false).length,
    nas_connected: true, roots }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
