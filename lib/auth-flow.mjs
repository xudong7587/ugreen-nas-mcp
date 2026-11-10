import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runUnc } from './unc.mjs';

export const AUTH_WAIT_MS = 10 * 60 * 1000;
export const AUTH_POLL_MS = 2000;

export class AuthFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

// The login URL contains an ephemeral secret. Keep it in memory, never in logs.
export function extractLoginUrl(output) {
  const input = Buffer.isBuffer(output) ? output.toString('utf8') : output;
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { /* Some CLI versions print a plain URL. */ }
  }
  const candidates = new Set();
  function visit(item) {
    if (typeof item === 'string') {
      for (const match of item.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
        const candidate = match[0];
        const shape = /^http:\/\/127\.0\.0\.1:(\d+)\/login\/[A-Za-z0-9_-]+(?:[/?#]|$)/.exec(candidate);
        if (!shape || Number(shape[1]) < 1 || Number(shape[1]) > 65535) continue;
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
            && !parsed.username && !parsed.password
            && /^\/login\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)
            && !parsed.search && (!parsed.hash || parsed.hash === '#/')) {
            candidates.add(candidate);
          }
        } catch { /* Ignore malformed candidates without echoing them. */ }
      }
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  }
  visit(value);
  if (candidates.size !== 1) {
    throw new AuthFlowError('INVALID_LOGIN_URL', '官方 CLI 没有返回唯一有效的本机登录地址。请检查或更新官方 CLI 后重试。');
  }
  return [...candidates][0];
}

export async function openLoginPage(url, { signal } = {}) {
  // Revalidate at the process boundary, even when this helper is called directly.
  if (extractLoginUrl(url) !== url) {
    throw new AuthFlowError('INVALID_LOGIN_URL', '登录地址不是有效的本机临时登录页。');
  }
  let command;
  let args;
  let env = process.env;
  if (process.platform === 'win32') {
    command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      'Start-Process -FilePath $env:UGREEN_CONNECT_LOGIN_URL -ErrorAction Stop'];
    env = { ...process.env, UGREEN_CONNECT_LOGIN_URL: url };
  } else {
    command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    args = [url];
  }
  await new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore', env, signal });
    } catch (error) { finish(error); return; }
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? undefined : new Error('Browser opener failed.')));
    timer = setTimeout(() => {
      finish(new Error('Browser opener timed out.'));
      child.kill();
    }, 15000);
  });
}

function cancelled(signal, error) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function checkCancellation(signal) {
  if (signal?.aborted) throw new AuthFlowError('CANCELLED', '已停止等待登录；未登出或清除已有凭据。');
}

// Classify failures without exposing server addresses, account names or tokens.
function safeCheckReason(value) {
  let description = '';
  try {
    description = value instanceof Error
      ? `${value.message} ${JSON.stringify(value.details || {})}`
      : JSON.stringify(value);
  } catch { /* Use the generic reason below. */ }
  if (/certificate|\bx509\b|\btls\b|证书/i.test(description)) return 'NAS 证书未通过校验；请核对证书与访问地址。';
  if (/unauthenticated|invalid bearer token|token[^\n]{0,50}(?:invalid|expired)|\b401\b|令牌.{0,12}(?:失效|过期|吊销)/i.test(description)) {
    return '凭据已失效、过期或被 NAS 拒绝。';
  }
  if (/permission.?denied|\b403\b|权限不足|未授权|没有权限/i.test(description)) return 'NAS 拒绝了检查请求，请核对令牌权限。';
  if (/timeout|timed.out|deadline|超时/i.test(description)) return '连接 NAS 超时，请检查 NAS 在线状态和网络。';
  if (/econn|enotfound|ehost|network|unreachable|无法连接|连接失败/i.test(description)) return '无法连接 NAS，请检查 NAS 在线状态和网络。';
  return '当前凭据或 NAS 连通性未通过真实检查，请检查网络、证书和令牌有效性。';
}

/** All effects are injectable so tests never need to create a real login session. */
export async function connectNas({
  run = runUnc,
  open = openLoginPage,
  wait = (ms, { signal } = {}) => delay(ms, undefined, { signal }),
  now = Date.now,
  report = () => {},
  signal,
  noOpen = false,
  timeoutMs = AUTH_WAIT_MS,
  pollIntervalMs = AUTH_POLL_MS,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new AuthFlowError('INVALID_OPTIONS', '登录等待时间和轮询间隔必须为正数。');
  }
  const emit = (stage, message, extra = {}) => report({ stage, message, ...extra });
  async function checkConnection(existing) {
    checkCancellation(signal);
    emit('checking_connection', '正在真实检查 NAS 连接。');
    let status;
    try {
      status = await run(['auth', 'status', '--check'], { signal });
      checkCancellation(signal);
    } catch (error) {
      if (cancelled(signal, error)) throw error;
      throw new AuthFlowError(existing ? 'EXISTING_AUTH_CHECK_FAILED' : 'AUTH_CHECK_FAILED',
        `${safeCheckReason(error)}${existing ? '本次保留已有授权，不会重新打开登录页或清除凭据。' : '本次没有清除凭据。'}`);
    }
    if (status?.success === false || status?.authenticated !== true || status?.opencli?.connected !== true) {
      throw new AuthFlowError(existing ? 'EXISTING_AUTH_CHECK_FAILED' : 'AUTH_CHECK_FAILED',
        `${safeCheckReason(status)}${existing ? '本次保留已有授权，不会重新打开登录页或清除凭据。' : '本次没有清除凭据。'}`);
    }
  }
  try {
    checkCancellation(signal);
    emit('checking_local', '正在检查本机已有的绿联云授权。');
    let initial;
    try { initial = await run(['auth', 'status'], { signal }); }
    catch (error) {
      if (cancelled(signal, error)) throw error;
      throw new AuthFlowError(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'LOCAL_STATUS_FAILED',
        error?.code === 'ENOENT' ? '未找到绿联官方 CLI，请先安装 unc 或检查 UGREEN_UNC_BIN 设置。' : '无法读取官方 CLI 的登录状态，请检查 CLI 安装后重试。');
    }
    checkCancellation(signal);
    if (typeof initial?.authenticated !== 'boolean' || initial.success === false) {
      throw new AuthFlowError('LOCAL_STATUS_FAILED', '官方 CLI 没有返回明确的登录状态；为保留已有授权，本次不启动新的登录页。');
    }
    if (initial?.authenticated === true) {
      await checkConnection(true);
      emit('connected', '已复用本机现有授权，NAS 连接检查通过。');
      return { authenticated: true, connected: true, reused: true };
    }

    emit('starting_login', '正在创建只供这台电脑使用的临时登录页。');
    const deadline = now() + timeoutMs;
    let output;
    try { output = await run(['auth', 'workbuddy', '--wait-timeout', '10m'], { signal, raw: true }); }
    catch (error) {
      if (cancelled(signal, error)) throw error;
      throw new AuthFlowError('LOGIN_START_FAILED', '官方 CLI 未能启动本机登录页，请检查或更新 CLI 后重试。');
    }
    checkCancellation(signal);
    const url = extractLoginUrl(output);
    if (noOpen) {
      emit('manual_url', '请在这台电脑的浏览器打开下方临时地址；不要分享或保存这个地址。', { url });
    } else {
      try { await open(url, { signal }); }
      catch (error) {
        if (cancelled(signal, error)) throw error;
        throw new AuthFlowError('BROWSER_OPEN_FAILED', '未能自动打开浏览器。请在本机终端运行 npm run connect -- --no-open，再手动打开新登录页。');
      }
    }
    checkCancellation(signal);
    emit('waiting_login', '请在网页填写 NAS 地址和访问令牌。保持此终端运行，最长等待 10 分钟。');
    while (now() < deadline) {
      checkCancellation(signal);
      let status;
      try { status = await run(['auth', 'status'], { signal }); }
      catch (error) {
        if (cancelled(signal, error)) throw error;
        throw new AuthFlowError('POLL_FAILED', '等待登录时无法读取官方 CLI 状态。本次未登出或清除凭据，请检查 CLI 后重试。');
      }
      checkCancellation(signal);
      if (typeof status?.authenticated !== 'boolean' || status.success === false) {
        throw new AuthFlowError('POLL_FAILED', '官方 CLI 没有返回明确的登录状态。本次未登出或清除凭据，请检查 CLI 后重试。');
      }
      if (status?.authenticated === true) {
        await checkConnection(false);
        emit('connected', '网页授权已完成，NAS 连接检查通过。');
        return { authenticated: true, connected: true, reused: false };
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await wait(Math.min(pollIntervalMs, remaining), { signal });
    }
    throw new AuthFlowError('LOGIN_TIMEOUT', '等待网页授权超时。请运行 npm run connect 创建新的临时登录页；本次未登出或清除凭据。');
  } catch (error) {
    if (cancelled(signal, error)) {
      throw new AuthFlowError('CANCELLED', '已停止等待登录；未登出或清除已有凭据。');
    }
    throw error;
  }
}
