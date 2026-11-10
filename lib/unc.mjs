import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 8 * 1024 * 1024;
const SECRET_KEYS = /^(?:token|access_token|refresh_token|client_secret|password|authorization)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item)]));
  }
  if (typeof value === 'string') {
    return value.replace(/ugpoa_v1\.[A-Za-z0-9_.-]+/g, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9_.~+\/-]+=*/gi, 'Bearer [REDACTED]');
  }
  return value;
}

export function uncBinary() {
  const binary = process.env.UGREEN_UNC_BIN || path.join(homedir(), '.local', 'bin',
    process.platform === 'win32' ? 'unc.exe' : 'unc');
  if (!path.isAbsolute(binary)) throw new Error('UGREEN_UNC_BIN 必须是 unc 可执行文件的绝对路径。');
  return binary;
}

export function uncEnvironment(source = process.env) {
  const blocked = new Set(['UNC_NAS_TOKEN', 'UNC_NAS_URL', 'UNC_NAS_INSECURE']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key.toUpperCase())));
}

// No shell, no credentials in arguments; the official CLI owns authentication.
export async function runUnc(args, { signal, raw = false, timeoutMs = 150000 } = {}) {
  const env = uncEnvironment();
  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(uncBinary(), [...args, '--format', raw ? 'raw' : 'json', '--timeout', '30'], {
        shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], signal,
      });
    } catch (error) { reject(error); return; }
    const stdout = [], stderr = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error('绿联 CLI 请求超时；请查询当前状态后再决定是否重试。');
      child.kill();
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        failure = new Error('CLI 输出超过 8 MiB，请缩小查询范围或使用分页。');
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  if (raw && result.code === 0) return result.stdout;
  let data;
  try { data = redact(JSON.parse(result.stdout.toString('utf8'))); }
  catch {
    const error = new Error(redact(result.stderr.trim()) || `CLI 未返回 JSON（退出码 ${result.code}）。`);
    throw error;
  }
  if (result.code !== 0 || data.success === false || data.items?.some(item => item.success === false)) {
    const error = new Error('绿联 CLI 请求失败；结构化原因见 details。');
    error.details = data;
    throw error;
  }
  return data;
}
