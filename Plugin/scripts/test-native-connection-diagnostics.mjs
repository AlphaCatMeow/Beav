#!/usr/bin/env node
// Exercise the actual Native Messaging and reporting modules together, without a desktop app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenario = process.argv[2];
const scenarios = {
  missing_host: 'NATIVE_HOST_NOT_REGISTERED',
  host_exit: 'NATIVE_HOST_EXITED',
  handshake_timeout: 'NATIVE_REQUEST_TIMEOUT',
  malformed_response: 'NATIVE_RESPONSE_INVALID',
  alternating_failures: 'NATIVE_HOST_NOT_REGISTERED',
  stale_upgrade: 'NATIVE_REQUEST_TIMEOUT',
  bridge_failure: 'DESKTOP_BRIDGE_DISCONNECTED',
  connected: '',
  app_absent: '',
};
if (!scenario) {
  for (const name of Object.keys(scenarios)) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(child.status, 0, `${name}: ${child.stdout}\n${child.stderr}`);
  }
  console.log(JSON.stringify({ ok: true, scenarios: Object.keys(scenarios) }, null, 2));
  process.exit(0);
}
assert(scenario in scenarios);

let now = Date.now();
let sequence = 0;
let connections = 0;
const timers = new Map();
const storage = {};
const submissions = [];
const observations = [];
Date.now = () => now;
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++sequence;
  timers.set(id, { at: now + delay, callback });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Edg/140.0.0.0',
} });
globalThis.chrome = {
  runtime: {
    id: 'dhfphfekcjahljnefpdjoidehnhhoeie',
    getManifest: () => ({ version: '2.7.16.65535', version_name: '2.7.16', permissions: ['nativeMessaging'] }),
    getPlatformInfo: async () => ({ os: 'win', arch: 'x86-64' }),
    connectNative: () => {
      connections += 1;
      if (scenario === 'missing_host' || (scenario === 'alternating_failures' && connections % 2 === 1)) {
        throw new Error('Specified native messaging host not found.');
      }
      const port = {
        onMessage: { addListener: (callback) => { port.receive = callback; } },
        onDisconnect: { addListener: (callback) => { port.closed = callback; } },
        postMessage: (request) => {
          if (['handshake_timeout', 'stale_upgrade', 'alternating_failures', 'host_exit'].includes(scenario)) return;
          setTimeout(() => port.receive({
            jsonrpc: scenario === 'malformed_response' ? '1.0' : '2.0',
            id: request.id,
            result: {
              ok: true, appVersion: '2.8.0',
              desktopBridge: {
                connected: scenario === 'connected', appVersion: '2.8.0',
                availability: scenario === 'bridge_failure' ? 'bridge_error' : 'app_not_running',
                errorCode: scenario === 'bridge_failure' ? 'DESKTOP_BRIDGE_DISCONNECTED' : '',
              },
            },
          }), 10);
        },
        disconnect: () => {},
      };
      if (scenario === 'host_exit') setTimeout(() => {
        chrome.runtime.lastError = { message: 'Native host has exited.' };
        port.closed();
        delete chrome.runtime.lastError;
      }, 10);
      return port;
    },
  },
  management: { getSelf: async () => ({ installType: 'development' }) },
  permissions: { getAll: async () => ({ permissions: ['nativeMessaging'], origins: ['https://api.ziz.hk/*'] }) },
  storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(storage[key])])),
    set: async (values) => Object.assign(storage, structuredClone(values)),
  } },
  alarms: { get: async () => ({}), create: async () => {}, clear: async () => {} },
};
globalThis.fetch = async (url, options) => {
  submissions.push({ url, request: JSON.parse(options.body) });
  return { ok: true, status: 201, json: async () => ({ item: { id: 'qa-feedback-receipt' } }) };
};
const native = await import('../src/background/nativeTransport.js');
const diagnostics = await import('../src/background/diagnostics.js');
let observed = Promise.resolve();
native.configureNativeTransport({ onStatusChange: (status) => {
  observations.push(status);
  observed = diagnostics.observePluginConnection(status);
} });
if (scenario === 'stale_upgrade') {
  storage[native.NATIVE_STATUS_KEY] = {
    state: 'disconnected', errorCode: 'NATIVE_HOST_EXITED', expectedDisconnect: true,
    lifecycle: { expected: true, reason: 'app_upgrade', atMs: now - 90_000 },
  };
  await native.restoreNativeStatus();
}
const connection = native.connectNativeTransport({ silent: true });
for (let step = 0; step < 240; step += 1) {
  now += 1_000;
  for (const [id, timer] of [...timers]) if (timer.at <= now) {
    timers.delete(id);
    timer.callback();
  }
  for (let flush = 0; flush < 200; flush += 1) await Promise.resolve();
}
await connection;
await observed;
const expectedCode = scenarios[scenario];
if (!expectedCode) {
  assert.equal(submissions.length, 0);
} else {
  assert.equal(submissions.length, 1, 'one report for a persistent incident, including alternating codes');
  const { request } = submissions[0];
  assert.equal(request.context.fields.code, expectedCode);
  assert.equal(request.context.fields.diagnosticVersion, 2);
  assert.equal(request.context.fields.firstFailure.code, expectedCode);
  assert.equal(request.context.fields.environment.os, 'win');
  assert.equal(request.context.fields.environment.nativeMessagingGranted, true);
  assert.equal(request.context.fields.browser, 'edge');
  assert.equal(request.context.fields.installationIdHash.length, 32);
  assert(!JSON.stringify(request).includes(storage.extensionInstanceId));
  assert(request.context.fields.connectionEvents.some((event) => event.includes('event=connect_started')));
  assert(!JSON.stringify(request.context.fields.connectionFacts).includes('[TRUNCATED]'));
  assert.match(request.log_text, /firstFailure=/);
  assert.equal(storage[diagnostics.PLUGIN_DIAGNOSTICS_DELIVERY_KEY].status, 'sent');
  assert.equal(storage[diagnostics.PLUGIN_DIAGNOSTICS_DELIVERY_KEY].feedbackId, 'qa-feedback-receipt');
  if (scenario === 'handshake_timeout') {
    assert.equal(request.context.fields.connectionFacts.firstMessageAt, 0);
    assert.equal(request.context.fields.connectionFacts.hostProcessConfirmed, false);
    assert(request.context.fields.connectionFacts.portOpenedAt > 0);
    assert(request.context.fields.connectionFacts.pingSentAt > 0);
  }
}
await native.disconnectNativeTransport('test_cleanup');
if (['missing_host', 'host_exit', 'handshake_timeout'].includes(scenario)) {
  await assert.rejects(native.requestNativeHost('desktop.health'), (error) => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_DISCONNECTED');
    assert.equal(error.details.causeCode, expectedCode);
    assert(error.details.causeMessage);
    return true;
  });
}
await native.disconnectNativeTransport('test_cleanup');
console.log(JSON.stringify({ scenario, connections, reports: submissions.length }));
