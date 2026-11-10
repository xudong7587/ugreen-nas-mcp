import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthFlowError, connectNas, extractLoginUrl, openLoginPage } from '../lib/auth-flow.mjs';

const LOGIN_URL = 'http://127.0.0.1:41234/login/TestNonce_abCdEf012345678901234567/#/';
const CONNECTED = { success: true, authenticated: true, opencli: { connected: true } };
const SECRET = 'ugpoa_v1.do_not_expose_test_secret';

// This clock never sleeps, and every CLI response is a mock. These tests must
// never open or replace a real login page or alter the user's saved credentials.
function harness({ authenticated = false, statuses = [true], checked = CONNECTED,
  output = Buffer.from(`Open this page: ${LOGIN_URL}\n`), runError, openError,
  onWait } = {}) {
  let currentTime = 0;
  let localChecks = 0;
  const calls = [], opened = [], waits = [], events = [];
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    now: () => currentTime,
    report: event => events.push(event),
    run: async (args, callOptions = {}) => {
      calls.push({ args: [...args], options: callOptions });
      if (runError) throw runError;
      if (args[0] === 'auth' && args[1] === 'status') {
        if (args.includes('--check')) {
          if (checked instanceof Error) throw checked;
          return checked;
        }
        const value = localChecks++ === 0 ? authenticated : statuses.shift() ?? false;
        return { success: true, authenticated: value };
      }
      if (args[0] === 'auth' && args[1] === 'workbuddy') return output;
      assert.fail(`Unexpected command: ${args.join(' ')}`);
    },
    open: async (url, callOptions = {}) => {
      opened.push({ url, options: callOptions });
      if (openError) throw openError;
    },
    wait: async (ms, callOptions = {}) => {
      waits.push({ ms, options: callOptions });
      currentTime += ms;
      await onWait?.({ controller, calls, currentTime });
      if (controller.signal.aborted) throw controller.signal.reason;
    },
  };
  return { options, calls, opened, waits, events, controller };
}

function diagnosticText(error, events) {
  return JSON.stringify({
    name: error?.name, message: error?.message, code: error?.code,
    properties: error ? Object.fromEntries(Object.entries(error)) : undefined,
    events,
  });
}

function safeFailure(error, events = []) {
  assert.ok(error instanceof AuthFlowError);
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  assert.match(error.message, /[\u3400-\u9fff]/, 'errors should give a safe Chinese explanation');
  assert.doesNotMatch(diagnosticText(error, events), /do_not_expose_test_secret|raw CLI diagnostic|TestNonce_abCdEf/);
  assert.equal('cause' in error, false, 'raw CLI errors must not survive as an exposed cause');
  return true;
}

test('login URL extraction accepts plain text, JSON, and Buffer output', () => {
  for (const output of [
    `请在浏览器中打开：${LOGIN_URL}\n`,
    JSON.stringify({ url: LOGIN_URL }),
    { data: { login_url: LOGIN_URL } },
    Buffer.from(`Login URL: ${LOGIN_URL}\n`),
    Buffer.from(JSON.stringify({ data: { login_url: LOGIN_URL } })),
  ]) assert.equal(extractLoginUrl(output), LOGIN_URL);
});

test('login URL extraction rejects remote hosts, userinfo, missing nonces, and ambiguous pages', () => {
  const invalid = [
    '',
    'https://127.0.0.1:41234/login/nonce/#/',
    'http://localhost:41234/login/nonce/#/',
    'http://192.168.1.1:41234/login/nonce/#/',
    'http://127.0.0.1.evil.invalid:41234/login/nonce/#/',
    'http://user:password@127.0.0.1:41234/login/nonce/#/',
    'http://127.0.0.1/login/nonce/#/',
    'http://127.0.0.1:0/login/nonce/#/',
    'http://127.0.0.1:65536/login/nonce/#/',
    'http://127.0.0.1:41234/login//#/',
    'http://127.0.0.1:41234/settings/#/',
    'http://127.0.0.1:41234/login/nonce/another-route/#/',
    'http://127.0.0.1:41234/login/nonce/?next=https://untrusted.invalid',
    'http://127.0.0.1:41234/login/nonce/#/another-route',
    `${LOGIN_URL}\nhttp://127.0.0.1:41235/login/OtherNonce_0123456789/#/`,
  ];
  for (const output of invalid) {
    assert.throws(() => extractLoginUrl(output), error => safeFailure(error));
  }
});

test('the browser process boundary rejects unsafe URLs before launching any process', async () => {
  for (const url of [
    'https://untrusted.invalid/login/nonce/#/',
    'http://user:password@127.0.0.1:41234/login/nonce/#/',
    `${LOGIN_URL}\nhttp://127.0.0.1:41235/login/OtherNonce/#/`,
  ]) await assert.rejects(openLoginPage(url), error => safeFailure(error));
});

test('an existing authenticated cache is reused only after a real connection check', async () => {
  const h = harness({ authenticated: true });
  assert.deepEqual(await connectNas(h.options), { authenticated: true, connected: true, reused: true });
  assert.deepEqual(h.calls.map(call => call.args), [
    ['auth', 'status'], ['auth', 'status', '--check'],
  ]);
  assert.equal(h.opened.length, 0);
  assert.equal(h.waits.length, 0);
  assert.doesNotMatch(JSON.stringify(h.events), /127\.0\.0\.1|authenticated|opencli|token/);
});

test('a failed cached connection never replaces or clears the existing authorization', async () => {
  const h = harness({ authenticated: true,
    checked: { success: true, authenticated: true, opencli: { connected: false, error: SECRET } } });
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'EXISTING_AUTH_CHECK_FAILED');
    return true;
  });
  assert.deepEqual(h.calls.map(call => call.args), [
    ['auth', 'status'], ['auth', 'status', '--check'],
  ]);
  assert.equal(h.opened.length, 0);
});

test('a cached connection check that throws preserves the cache and gives a safe Chinese reason', async () => {
  const cause = new Error(`certificate validation failed: raw CLI diagnostic ${SECRET}`);
  cause.details = { token: SECRET, url: LOGIN_URL };
  const h = harness({ authenticated: true, checked: cause });
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'EXISTING_AUTH_CHECK_FAILED');
    assert.match(error.message, /证书/);
    return true;
  });
  assert.deepEqual(h.calls.map(call => call.args), [
    ['auth', 'status'], ['auth', 'status', '--check'],
  ]);
  assert.equal(h.opened.length, 0);
  assert.equal(h.waits.length, 0);
});

test('first authorization opens only the generated local page and verifies the NAS before success', async () => {
  const h = harness({ statuses: [false, false, true] });
  assert.deepEqual(await connectNas(h.options), { authenticated: true, connected: true, reused: false });
  assert.deepEqual(h.opened.map(call => call.url), [LOGIN_URL]);
  const start = h.calls.find(call => call.args[1] === 'workbuddy');
  assert.ok(start, 'must start an official WorkBuddy authorization flow');
  assert.equal(start.options.raw, true);
  assert.ok(start.args.includes('--wait-timeout'));
  assert.equal(start.args[start.args.indexOf('--wait-timeout') + 1], '10m');
  assert.deepEqual(h.calls.at(-1).args, ['auth', 'status', '--check']);
  assert.ok(h.waits.length >= 2, 'the CLI login service should be polled until completion');
  assert.ok(h.waits.every(call => call.ms === 2000));
  assert.ok(h.calls.every(call => call.options.signal === h.controller.signal));
  assert.ok(h.opened.every(call => call.options.signal === h.controller.signal));
  assert.ok(h.waits.every(call => call.options.signal === h.controller.signal));
  assert.doesNotMatch(JSON.stringify(h.events), /127\.0\.0\.1|TestNonce_abCdEf|authenticated|opencli|token/);
});

test('manual mode exposes the one-time page only in its explicit event and never opens a browser', async () => {
  const h = harness();
  await connectNas({ ...h.options, noOpen: true });
  assert.equal(h.opened.length, 0);
  const links = h.events.filter(event => event.url !== undefined);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, LOGIN_URL);
  assert.doesNotMatch(JSON.stringify(h.events.filter(event => event.url === undefined)), /127\.0\.0\.1|TestNonce_abCdEf/);
});

test('an invalid or ambiguous CLI login page is rejected before any browser or status polling', async () => {
  for (const output of [
    'http://untrusted.invalid/login/nonce/#/',
    `${LOGIN_URL}\nhttp://127.0.0.1:41235/login/OtherNonce/#/`,
  ]) {
    const h = harness({ output });
    await assert.rejects(connectNas(h.options), error => {
      safeFailure(error, h.events);
      assert.equal(error.code, 'INVALID_LOGIN_URL');
      return true;
    });
    assert.equal(h.opened.length, 0);
    assert.equal(h.waits.length, 0);
    assert.equal(h.calls.filter(call => call.args[1] === 'status').length, 1);
  }
});

test('a browser launch failure stops safely before polling without changing existing pages', async () => {
  const h = harness({ openError: new Error(`raw CLI diagnostic ${SECRET}`) });
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'BROWSER_OPEN_FAILED');
    return true;
  });
  assert.equal(h.opened.length, 1);
  assert.equal(h.waits.length, 0);
  assert.deepEqual(h.calls.filter(call => call.args[1] === 'status').map(call => call.args), [['auth', 'status']]);
});

test('a locally authenticated result without a connected NAS is not reported as success', async () => {
  const h = harness({ checked: { success: true, authenticated: true, opencli: { connected: false } } });
  await assert.rejects(connectNas(h.options), error => safeFailure(error, h.events));
  assert.deepEqual(h.calls.at(-1).args, ['auth', 'status', '--check']);
});

test('missing authentication or connection checks never report successful authorization', async () => {
  for (const checked of [
    { success: true, authenticated: true },
    { success: true, authenticated: false, opencli: { connected: true } },
    { success: false, authenticated: true, opencli: { connected: true } },
  ]) {
    const h = harness({ checked });
    await assert.rejects(connectNas(h.options), error => safeFailure(error, h.events));
    assert.equal(h.events.some(event => event.stage === 'connected'), false);
  }
});

test('an ambiguous local authentication status does not replace an unknown cached session', async () => {
  const h = harness();
  h.options.run = async args => {
    h.calls.push({ args: [...args] });
    return { success: true };
  };
  await assert.rejects(connectNas(h.options), error => safeFailure(error, h.events));
  assert.deepEqual(h.calls.map(call => call.args), [['auth', 'status']]);
  assert.equal(h.opened.length, 0);
});

test('timeout keeps saved authorization and does not log out or reset the CLI', async () => {
  const h = harness({ statuses: [] });
  await assert.rejects(connectNas({ ...h.options, timeoutMs: 5000 }), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'LOGIN_TIMEOUT');
    return true;
  });
  assert.ok(h.waits.length > 0);
  assert.ok(h.calls.every(call => call.args[0] === 'auth'
    && ['status', 'workbuddy'].includes(call.args[1])));
  assert.equal(h.calls.some(call => call.args.includes('--check')), false);
});

test('cancellation during polling stops without resetting authentication', async () => {
  const h = harness({ statuses: [], onWait: ({ controller }) => {
    controller.abort(new Error(`raw CLI diagnostic ${SECRET}`));
  } });
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'CANCELLED');
    return true;
  });
  assert.equal(h.waits.length, 1);
  assert.ok(h.calls.every(call => ['status', 'workbuddy'].includes(call.args[1])));
});

test('an already cancelled request does not start a CLI or browser operation', async () => {
  const h = harness();
  h.controller.abort(new Error(`raw CLI diagnostic ${SECRET}`));
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'CANCELLED');
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.opened.length, 0);
});

test('a CLI failure reports a safe explanation without the token, status object, or raw cause', async () => {
  const cause = new Error(`raw CLI diagnostic ${SECRET} ${LOGIN_URL}`);
  cause.details = { authenticated: true, token: SECRET, opencli: { connected: false } };
  const h = harness({ runError: cause });
  await assert.rejects(connectNas(h.options), error => {
    safeFailure(error, h.events);
    assert.equal(error.code, 'LOCAL_STATUS_FAILED');
    return true;
  });
  assert.equal(h.opened.length, 0);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(diagnosticText(undefined, h.events), /authenticated|opencli|token/);
});
