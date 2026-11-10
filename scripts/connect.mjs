import { AuthFlowError, connectNas } from '../lib/auth-flow.mjs';

const options = process.argv.slice(2);
if (options.includes('--help') || options.includes('-h')) {
  console.log('用法：npm run connect [-- --no-open]');
  console.log('检查并复用已有授权；首次连接时打开绿联官方本机网页登录页并等待授权完成。');
  console.log('--no-open  不自动打开浏览器，仅在本机终端显示本次临时登录地址。');
} else if (options.some(option => option !== '--no-open')) {
  console.error('不支持的参数。请运行 npm run connect -- --help 查看用法。');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await connectNas({
      noOpen: options.includes('--no-open'),
      signal: controller.signal,
      report(event) {
        console.log(event.message);
        if (event.stage === 'manual_url') console.log(event.url);
      },
    });
  } catch (error) {
    // Never print raw CLI output, error causes, status objects or credentials.
    console.error(error instanceof AuthFlowError ? error.message : '连接助手运行失败。请检查官方 CLI 后重试。');
    process.exitCode = error instanceof AuthFlowError && error.code === 'CANCELLED' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
