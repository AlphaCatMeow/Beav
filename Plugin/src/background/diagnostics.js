import { getNativeStatus } from './nativeTransport.js';
import { ensureLifecycleInstallState } from './lifecycleGuard.js';

export const PLUGIN_DIAGNOSTICS_QUEUE_KEY = 'redboxPluginDiagnosticsQueue';
export const PLUGIN_DIAGNOSTICS_DELIVERY_KEY = 'redboxPluginDiagnosticsDelivery';
export const PLUGIN_CONNECTION_INCIDENT_KEY = 'redboxPluginConnectionIncident';
export const PLUGIN_DIAGNOSTICS_RECENT_KEY = 'redboxPluginDiagnosticsRecent';
export const PLUGIN_DIAGNOSTICS_RETRY_ALARM = 'redbox-plugin-diagnostics-retry';
export const PLUGIN_FEEDBACK_ENDPOINT = 'https://api.ziz.hk/beav/v1/public-feedback';

const QUEUE_LIMIT = 40;
const RECENT_LIMIT = 120;
const SAME_INCIDENT_COOLDOWN_MS = 24 * 60 * 60_000;
const RETRY_COOLDOWN_MS = 30_000;
const DRAIN_BATCH_LIMIT = 4;
const MAX_MESSAGE_CHARS = 600;
const MAX_FIELD_CHARS = 500;
const DIRECT_SUBMIT_TIMEOUT_MS = 8_000;
const MAX_DELIVERY_ATTEMPTS = 8;

const CONNECTION_FAILURE_CODES = /^(NATIVE_HOST_EXITED|NATIVE_HOST_NOT_REGISTERED|NATIVE_HOST_FORBIDDEN|NATIVE_HOST_START_FAILED|NATIVE_HOST_UPGRADE_REQUIRED|NATIVE_REQUEST_TIMEOUT|NATIVE_TRANSPORT_DISCONNECTED|NATIVE_RESPONSE_INVALID|PLUGIN_INITIALIZATION_FAILED|DESKTOP_BRIDGE_ERROR|DESKTOP_BRIDGE_DISCONNECTED|.*PROTOCOL_MISMATCH|.*AUTHENTICATION_FAILED|.*VERSION_STALE)$/;
const APP_UNAVAILABLE_CODES = /^(APP_NOT_RUNNING|APP_STARTING|APP_SHUTTING_DOWN|APP_BRIDGE_UNAVAILABLE)$/;
const CONNECTION_EVENT_LIMIT = 40;
let connectionObservationPromise = Promise.resolve();
let drainPromise = null;
let enqueuePromise = Promise.resolve();
let storeMutationPromise = Promise.resolve();
let installationFingerprintPromise = null;
let environmentPromise = null;

// Store the first failure and a bounded timeline across MV3 worker restarts.
export async function observePluginConnection(status = {}, options = {}) {
  const snapshot = structuredClone(status);
  const next = connectionObservationPromise.then(() => observeConnection(snapshot, options));
  connectionObservationPromise = next.catch(() => {});
  return await next;
}

async function observeConnection(status, options) {
  const code = String(status.errorCode || '').toUpperCase();
  const now = Date.now();
  const stored = await globalThis.chrome?.storage?.local?.get?.([PLUGIN_CONNECTION_INCIDENT_KEY]);
  const previous = stored?.[PLUGIN_CONNECTION_INCIDENT_KEY];
  const expectedLifecycle = (status.expectedDisconnect === true || status.lifecycle?.expected === true)
    && now - Number(status.lifecycle?.atMs || status.lastChecked || 0) < 20_000;
  const appUnavailable = APP_UNAVAILABLE_CODES.test(code);
  const userRequested = options.userRequested === true
    || (Number(previous?.lastUserCheckAt || 0) > now - 90_000);
  if (status.state === 'connected' || status.error === 'manual_disconnect' || expectedLifecycle
    || (appUnavailable && !userRequested)) {
    await globalThis.chrome?.storage?.local?.set?.({ [PLUGIN_CONNECTION_INCIDENT_KEY]: null });
    return { skipped: true };
  }
  // Intermediate status notifications are not recovery and must not erase the first error.
  if (!CONNECTION_FAILURE_CODES.test(code) && !appUnavailable && status.state !== 'bridge_error') {
    return { skipped: true };
  }
  const sameIncident = previous && now >= previous.lastSeenAt && now - previous.lastSeenAt < 5 * 60_000;
  const sampled = !sameIncident || now - Number(previous.lastCountedAt || previous.lastSeenAt) >= 10_000;
  const firstFailure = sameIncident && previous.firstFailure ? previous.firstFailure : compactFailure(status.firstFailure || status.lastFailure || {
    at: now, code, phase: status.lastFailure?.phase || status.currentAttempt?.phase || 'native_connection',
    message: status.error, attemptId: status.currentAttempt?.id,
  });
  const incident = {
    code: sameIncident ? previous.code : code,
    firstSeenAt: sameIncident ? previous.firstSeenAt : now,
    lastSeenAt: now,
    lastCountedAt: sampled ? now : previous.lastCountedAt || previous.lastSeenAt,
    observations: sameIncident ? Math.min(999, previous.observations + (sampled ? 1 : 0)) : 1,
    lastUserCheckAt: options.userRequested === true ? now : Number(previous?.lastUserCheckAt || 0),
    firstFailure,
    latestFailure: compactFailure(status.lastFailure || { at: now, code, message: status.error, phase: status.currentAttempt?.phase }),
    events: [...new Set([
      ...(sameIncident && Array.isArray(previous.events) ? previous.events : []),
      ...compactConnectionEvents(status.telemetry),
    ])].slice(-CONNECTION_EVENT_LIMIT),
  };
  await globalThis.chrome?.storage?.local?.set?.({ [PLUGIN_CONNECTION_INCIDENT_KEY]: incident });
  if (incident.observations < 3 || now - incident.firstSeenAt < 60_000 || !sampled) return { skipped: true };
  return await reportPluginError(new Error(`Persistent browser connection failure: ${incident.code}`), {
    category: 'plugin.connection',
    event: 'plugin.connection.persistent_failure',
    operation: 'native-transport',
    trigger: 'automatic_connection_diagnostic',
    code: incident.code,
    phase: 'native_connection',
    retryable: true,
    fields: {
      confirmedConnectionFailure: true,
      userRequested: incident.lastUserCheckAt > 0,
      failureDurationMs: now - incident.firstSeenAt,
      failureObservations: incident.observations,
      firstFailure: incident.firstFailure,
      latestFailure: incident.latestFailure,
      nativeStatus: compactNativeStatus(status),
      connectionFacts: compactConnectionFacts(status),
      connectionEvents: incident.events,
    },
  });
}

function compactFailure(failure = {}) {
  return {
    at: Number(failure.at) || 0,
    code: safeToken(failure.code, 'unknown'),
    phase: safeToken(failure.phase, 'unknown'),
    message: redactText(failure.message || '', 400),
    attemptId: safeToken(failure.attemptId, ''),
  };
}

function compactConnectionFacts(status = {}) {
  const attempt = status.currentAttempt || {};
  return {
    workerStartedAt: Number(status.workerStartedAt) || 0,
    attemptId: safeToken(attempt.id, ''),
    attemptStartedAt: Number(attempt.startedAt) || 0,
    phase: safeToken(attempt.phase, 'not_started'),
    portOpenedAt: Number(attempt.portOpenedAt) || 0,
    firstMessageAt: Number(attempt.firstMessageAt) || 0,
    receivedMessages: Number(attempt.receivedMessages) || 0,
    pingSentAt: Number(attempt.pingSentAt) || 0,
    pingResponseAt: Number(attempt.pingResponseAt) || 0,
    handshakeReceivedAt: Number(status.handshakeReceivedAt) || 0,
    lastConnectedAt: Number(status.lastConnectedAt) || 0,
    registrationSucceeded: status.registrationSucceeded === true,
    hostProcessConfirmed: Boolean(attempt.firstMessageAt),
    hostLogAccess: 'unavailable_from_extension',
    otherExtensions: 'not_enumerated_no_management_permission',
  };
}

function compactConnectionEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => (
    !String(event.type || '').startsWith('request_')
    || ['ping', 'extension.register', 'desktop.health', 'desktop.context'].includes(event.method)
  )).slice(-CONNECTION_EVENT_LIMIT).map((event) => (
    `at=${Number(event.at) || 0} event=${safeToken(event.type, 'unknown')}`
    + ` attempt=${safeToken(event.attemptId, '')} retry=${Number(event.reconnectAttempt) || 0}`
    + ` phase=${safeToken(event.phase, '')} elapsedMs=${Number(event.elapsedMs) || 0}`
    + (event.method ? ` method=${safeToken(event.method, '')}` : '')
    + (event.timeoutMs ? ` timeoutMs=${Number(event.timeoutMs) || 0}` : '')
    + (event.errorCode ? ` code=${safeToken(event.errorCode, '')}` : '')
    + (event.hostVersion ? ` host=${safeToken(event.hostVersion, '')}` : '')
    + (event.appVersion ? ` app=${safeToken(event.appVersion, '')}` : '')
    + (event.error ? ` error=${redactText(event.error, 160)}` : '')
  ));
}

async function connectionEnvironment() {
  if (!environmentPromise) environmentPromise = (async () => {
    const manifest = globalThis.chrome?.runtime?.getManifest?.() || {};
    const [platform, self, permissions, hints] = await Promise.all([
      boundedProbe(() => globalThis.chrome?.runtime?.getPlatformInfo?.()),
      boundedProbe(() => globalThis.chrome?.management?.getSelf?.()),
      boundedProbe(() => globalThis.chrome?.permissions?.getAll?.()),
      boundedProbe(() => globalThis.navigator?.userAgentData?.getHighEntropyValues?.(['platformVersion', 'architecture', 'bitness'])),
    ]);
    return {
      extensionId: safeToken(globalThis.chrome?.runtime?.id, 'unknown'),
      manifestVersion: String(manifest.version || ''),
      installType: safeToken(self?.installType, 'unknown'),
      os: safeToken(platform?.os || detectPlatform(), 'unknown'),
      architecture: safeToken(platform?.arch || hints?.architecture, 'unknown'),
      bitness: safeToken(hints?.bitness, 'unknown'),
      osVersion: safeToken(hints?.platformVersion, 'unknown'),
      nativeMessagingDeclared: manifest.permissions?.includes('nativeMessaging') === true,
      nativeMessagingGranted: Array.isArray(permissions?.permissions) ? permissions.permissions.includes('nativeMessaging') : null,
      feedbackOriginGranted: Array.isArray(permissions?.origins)
        ? permissions.origins.some((origin) => origin === '<all_urls>' || origin === 'https://api.ziz.hk/*') : null,
    };
  })().catch(() => ({ probeFailed: true }));
  return await environmentPromise;
}

async function boundedProbe(probe) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(probe).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function reportPluginError(error, options = {}) {
  const next = enqueuePromise.then(() => enqueuePluginError(error, options));
  enqueuePromise = next.catch(() => {});
  return await next;
}

async function enqueuePluginError(error, options = {}) {
  const payload = buildPluginDiagnosticPayload(error, options);
  const submission = classifyPluginDiagnosticSubmission(payload);
  if (!submission.submit) {
    return {
      success: true,
      skipped: true,
      reason: submission.reason,
      queued: 0,
    };
  }
  if (String(payload.category).includes('connection')) {
    payload.fields.diagnosticVersion = 2;
    payload.fields.environment = await connectionEnvironment();
  }
  const installationIdHash = await resolveInstallationFingerprint();
  if (installationIdHash) payload.fields.installationIdHash = installationIdHash;
  const dedupeKey = buildDedupeKey(payload);
  const now = Date.now();
  const result = await mutateDiagnosticStore((store) => {
    const recent = pruneRecentReports(store.recent, now);
    const previousEpisode = readEpisode(recent[dedupeKey]);
    if (previousEpisode && now - previousEpisode.lastSeenAt < SAME_INCIDENT_COOLDOWN_MS) {
      const episode = nextEpisode(previousEpisode, now);
      recent[dedupeKey] = episode;
      return {
        queue: updateQueuedEpisode(store.queue, dedupeKey, episode, payload),
        recent,
        result: { skipped: true, reason: 'active_episode', occurrences: episode.occurrences },
      };
    }
    const episode = { firstSeenAt: now, lastSeenAt: now, occurrences: 1 };
    recent[dedupeKey] = episode;
    payload.fields = withEpisodeFields(payload.fields, dedupeKey, episode);
    const entry = {
      id: `plugin-diagnostic-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      dedupeKey,
      queuedAt: now,
      lastSeenAt: now,
      lastAttemptAt: 0,
      attempts: 0,
      occurrences: 1,
      payload,
    };
    return {
      queue: [...store.queue.filter((candidate) => candidate.dedupeKey !== dedupeKey), entry].slice(-QUEUE_LIMIT),
      recent,
      result: { reportId: entry.id },
    };
  });
  if (!result.skipped) {
    await recordDiagnosticDelivery({ status: 'queued', reportId: result.reportId, at: now });
    await schedulePluginDiagnosticsRetry();
  }
  return { ...(await drainPluginDiagnostics()), ...result };
}

export async function drainPluginDiagnostics() {
  if (drainPromise) return await drainPromise;
  drainPromise = (async () => {
    let sent = 0;
    let dropped = 0;
    for (let index = 0; index < DRAIN_BATCH_LIMIT; index += 1) {
      const store = await readDiagnosticStore();
      const now = Date.now();
      const entry = store.queue.find((candidate) => (
        candidate
          && candidate.payload
          && (now - Number(candidate.lastAttemptAt || 0) >= RETRY_COOLDOWN_MS)
      ));
      if (!entry) break;

      const submission = classifyPluginDiagnosticSubmission(entry.payload);
      if (!submission.submit) {
        await removeQueuedReport(entry.id);
        dropped += 1;
        continue;
      }
      await markAttempt(entry.id, now);
      try {
        const delivery = await submitPluginDiagnostic(entry.payload, entry.id);
        await recordDiagnosticDelivery({
          status: 'sent', reportId: entry.id, at: Date.now(),
          httpStatus: delivery.status, feedbackId: safeToken(delivery.response?.item?.id || delivery.response?.data?.item?.id, ''),
          attempts: Number(entry.attempts || 0) + 1,
        });
        await removeQueuedReport(entry.id);
        sent += 1;
      } catch (error) {
        await recordDiagnosticDelivery({
          status: error?.permanent === true ? 'rejected' : 'retry_pending',
          reportId: entry.id, at: Date.now(), httpStatus: Number(error?.status || 0),
          error: redactText(error instanceof Error ? error.message : String(error), 400),
          attempts: Number(entry.attempts || 0) + 1,
        });
        if (error?.permanent === true || Number(entry.attempts || 0) + 1 >= MAX_DELIVERY_ATTEMPTS) {
          await removeQueuedReport(entry.id);
          await recordDiagnosticDelivery({ status: 'dropped', reportId: entry.id, at: Date.now(),
            httpStatus: Number(error?.status || 0), error: redactText(error?.message, 400),
            reason: error?.permanent === true ? 'permanent_rejection' : 'retry_limit' });
          dropped += 1;
        }
        break;
      }
    }

    const pending = (await readDiagnosticStore()).queue.length;
    if (pending > 0) {
      await schedulePluginDiagnosticsRetry();
    } else {
      await clearPluginDiagnosticsRetry();
    }
    return { success: true, sent, dropped, queued: pending };
  })().finally(() => {
    drainPromise = null;
  });
  return await drainPromise;
}

export async function submitPluginDiagnostic(payload, reportId = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIRECT_SUBMIT_TIMEOUT_MS);
  try {
    const response = await fetch(PLUGIN_FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildPluginFeedbackRequest(payload, reportId)),
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok || responseBody?.success === false) {
      const error = createDiagnosticSendError(
        responseBody?.message || `Plugin diagnostics failed with HTTP ${response.status}`,
      );
      error.status = response.status;
      error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      throw error;
    }
    if (!responseBody?.item?.id && !responseBody?.data?.item?.id && responseBody?.success !== true) {
      const error = createDiagnosticSendError('Plugin diagnostics response did not acknowledge submission');
      error.status = response.status;
      throw error;
    }
    return {
      success: true,
      status: response.status,
      response: responseBody,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildPluginFeedbackRequest(payload = {}, reportId = '') {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const category = String(payload.category || '').includes('connection')
    ? 'plugin_connection'
    : 'plugin_capture';
  const event = safeToken(payload.event || 'plugin.error', 'plugin.error');
  const trigger = safeToken(payload.trigger || 'plugin_error', 'plugin_error');
  const code = safeToken(fields.code || 'PLUGIN_ERROR', 'PLUGIN_ERROR');
  const phase = safeToken(fields.phase || '', 'unknown');
  const extensionVersion = String(fields.extensionVersion || '').slice(0, 32);
  const browser = safeToken(fields.browser || 'unknown', 'unknown');
  const message = redactText(payload.message || 'Browser plugin error', 1_000);
  const context = sanitizeValue({
    schema: 'redbox.browserPluginDiagnostic.v1',
    automatic: true,
    reportId: safeToken(reportId, ''),
    event,
    trigger,
    fields,
  });
  return {
    title: category === 'plugin_connection'
      ? '浏览器插件连接失败（自动上报）'
      : '浏览器插件采集失败（自动上报）',
    content: `插件自动上报：${message}`.slice(0, 4_000),
    category,
    priority: classifyPluginFeedbackPriority(payload),
    source: 'browser_extension',
    request_kind: 'plugin_error',
    client: {
      product: 'beav',
      extensionVersion,
      browser,
    },
    log_text: redactText([
      `event=${event} trigger=${trigger} code=${code} phase=${phase}`,
      `extension=${extensionVersion} browser=${browser} platform=${safeToken(fields.platform, 'unknown')}`,
      `host=${safeToken(fields.nativeStatus?.nativeHostVersion, 'unknown')} app=${safeToken(fields.nativeStatus?.desktopAppVersion, 'unknown')}`,
      `environment=${JSON.stringify(fields.environment || {})}`,
      `firstFailure=${JSON.stringify(fields.firstFailure || {})}`,
      `latestFailure=${JSON.stringify(fields.latestFailure || {})}`,
      `connectionFacts=${JSON.stringify(fields.connectionFacts || {})}`,
      `nativeStatus=${JSON.stringify(fields.nativeStatus || {})}`,
      ...(Array.isArray(fields.connectionEvents) ? fields.connectionEvents.slice(-CONNECTION_EVENT_LIMIT) : []),
    ].join('\n'), 16_000),
    attachments: [],
    context,
  };
}

export function classifyPluginFeedbackPriority(payload = {}) {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const code = String(fields.code || '').trim().toUpperCase();
  const message = String(payload.message || '');
  const nativeStatus = fields.nativeStatus && typeof fields.nativeStatus === 'object'
    ? fields.nativeStatus
    : {};
  const expectedDisconnect = fields.expected === true
    || fields.userActionRequired === true
    || nativeStatus.expectedDisconnect === true
    || nativeStatus.lifecycle?.expected === true;
  const expectedCaptureFailure = /^(OPERATION_CANCELLED|POLICY_DENIED|URL_NOT_BELONG_TO_XIAOHONGSHU|UNSUPPORTED_URL|UNSUPPORTED_PAGE|CAPTURE_NOT_APPLICABLE|SPACE_INITIALIZING)$/.test(code)
    || /^URL does not belong to (?:小红书|Xiaohongshu)$/i.test(message.trim());
  const expectedConnectionState = /^(APP_NOT_RUNNING|APP_STARTING|APP_SHUTTING_DOWN|APP_BRIDGE_UNAVAILABLE|NATIVE_HOST_RESTARTING)$/.test(code);
  const protocolOrAuthorizationFailure = /(?:PROTOCOL_MISMATCH|AUTHENTICATION_FAILED|VERSION_STALE|UNTRUSTED_ORIGIN)/.test(code);
  const outcomeUnknown = /(?:WRITE_OUTCOME_UNKNOWN|OPERATION_OUTCOME_UNKNOWN)/.test(code);

  if (expectedDisconnect || expectedCaptureFailure || expectedConnectionState) return 'low';
  if (protocolOrAuthorizationFailure || outcomeUnknown) return 'high';
  return 'normal';
}

export function classifyPluginDiagnosticSubmission(payload = {}) {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const category = String(payload.category || '').trim().toLowerCase();
  const event = String(payload.event || '').trim().toLowerCase();
  const code = String(fields.code || '').trim().toUpperCase();
  const priority = classifyPluginFeedbackPriority(payload);
  const nativeStatus = fields.nativeStatus && typeof fields.nativeStatus === 'object'
    ? fields.nativeStatus
    : {};
  const expected = fields.expected === true
    || fields.userActionRequired === true
    || nativeStatus.expectedDisconnect === true
    || nativeStatus.lifecycle?.expected === true;
  const expectedOutcome = /^(OPERATION_CANCELLED|POLICY_DENIED|URL_NOT_BELONG_TO_XIAOHONGSHU|UNSUPPORTED_URL|UNSUPPORTED_PAGE|CAPTURE_NOT_APPLICABLE|SPACE_INITIALIZING)$/.test(code);
  const unavailableConnection = /^(APP_NOT_RUNNING|APP_STARTING|APP_SHUTTING_DOWN|APP_BRIDGE_UNAVAILABLE|NATIVE_HOST_EXITED|NATIVE_HOST_NOT_REGISTERED|NATIVE_HOST_RESTARTING|NATIVE_TRANSPORT_DISCONNECTED)$/.test(code);

  if (event.endsWith('.recovered')) return { submit: false, reason: 'recovery_telemetry' };
  if (expected || expectedOutcome) return { submit: false, reason: 'expected_outcome' };
  if (category.includes('connection')) {
    if (fields.confirmedConnectionFailure === true && (CONNECTION_FAILURE_CODES.test(code) || /^DESKTOP_BRIDGE_/.test(code) || (fields.userRequested === true && APP_UNAVAILABLE_CODES.test(code)))) {
      return { submit: true, reason: 'persistent_connection_failure' };
    }
    return priority === 'high' && fields.retryable !== true
      ? { submit: true, reason: 'actionable_connection_failure' }
      : { submit: false, reason: 'connection_telemetry' };
  }
  if (unavailableConnection) return { submit: false, reason: 'connection_unavailable' };
  return { submit: true, reason: 'actionable_operation_failure' };
}

export async function schedulePluginDiagnosticsRetry() {
  if (!globalThis.chrome?.alarms?.create) return;
  const existing = await callChromePromise(
    globalThis.chrome.alarms.get?.(PLUGIN_DIAGNOSTICS_RETRY_ALARM),
    null,
  );
  if (!existing) {
    await callChromePromise(
      globalThis.chrome.alarms.create(PLUGIN_DIAGNOSTICS_RETRY_ALARM, {
        periodInMinutes: 1,
      }),
      undefined,
    );
  }
}

export async function clearPluginDiagnosticsRetry() {
  await callChromePromise(
    globalThis.chrome?.alarms?.clear?.(PLUGIN_DIAGNOSTICS_RETRY_ALARM),
    undefined,
  );
}

export function buildPluginDiagnosticPayload(error, options = {}) {
  const errorRecord = error && typeof error === 'object' ? error : {};
  const message = redactText(
    options.message || errorRecord.message || error || 'Browser plugin error',
    MAX_MESSAGE_CHARS,
  );
  const code = safeToken(options.code || errorRecord.code || 'PLUGIN_ERROR', 'PLUGIN_ERROR');
  const operation = safeToken(options.operation || 'unknown', 'unknown');
  const event = safeToken(options.event || 'plugin.error', 'plugin.error');
  const category = safeToken(options.category || 'plugin.browser', 'plugin.browser');
  const trigger = safeToken(options.trigger || 'plugin_error', 'plugin_error');
  const nativeStatus = compactNativeStatus(getNativeStatus());
  const manifest = globalThis.chrome?.runtime?.getManifest?.() || {};

  const fields = sanitizeValue({
    source: 'browser_extension',
    extensionVersion: String(manifest.version_name || manifest.version || '').slice(0, 32),
    browser: detectBrowserFamily(),
    platform: detectPlatform(),
    browserVersion: String(globalThis.navigator?.userAgent || '').match(/(?:Edg|Chrome|Chromium)\/([\d.]+)/)?.[1] || '',
    operation,
    code,
    phase: safeToken(options.phase || errorRecord.phase || '', ''),
    retryable: errorRecord.retryable === true || options.retryable === true,
    expected: errorRecord.expected === true || options.expected === true,
    errorName: String(errorRecord.name || '').slice(0, 80),
    nativeStatus,
    ...(options.sourceOrigin ? { sourceOrigin: safeOrigin(options.sourceOrigin) } : {}),
    ...(options.fields && typeof options.fields === 'object' ? options.fields : {}),
    ...(errorRecord.details ? { details: errorRecord.details } : {}),
  });

  return {
    level: options.level || 'error',
    category,
    event,
    message: message || 'Browser plugin error',
    fields,
    trigger,
  };
}

function buildDedupeKey(payload) {
  const fields = payload.fields || {};
  return [
    payload.category,
    normalizeDiagnosticOperation(fields.operation),
    fields.code,
    fields.phase,
  ].map((value) => String(value || '').slice(0, 96)).join(':').slice(0, 320);
}

function normalizeDiagnosticOperation(value = '') {
  return String(value).replace(/^(?:message|task):/, 'workflow:');
}

async function readDiagnosticStore() {
  const result = await callChromePromise(
    globalThis.chrome?.storage?.local?.get?.([
      PLUGIN_DIAGNOSTICS_QUEUE_KEY,
      PLUGIN_DIAGNOSTICS_RECENT_KEY,
    ]),
    {},
  );
  return {
    queue: Array.isArray(result?.[PLUGIN_DIAGNOSTICS_QUEUE_KEY])
      ? result[PLUGIN_DIAGNOSTICS_QUEUE_KEY].filter((entry) => entry && typeof entry === 'object')
      : [],
    recent: result?.[PLUGIN_DIAGNOSTICS_RECENT_KEY]
      && typeof result[PLUGIN_DIAGNOSTICS_RECENT_KEY] === 'object'
      ? result[PLUGIN_DIAGNOSTICS_RECENT_KEY]
      : {},
  };
}

async function writeDiagnosticStore({ queue, recent }) {
  await globalThis.chrome?.storage?.local?.set?.({
    [PLUGIN_DIAGNOSTICS_QUEUE_KEY]: Array.isArray(queue) ? queue.slice(-QUEUE_LIMIT) : [],
    [PLUGIN_DIAGNOSTICS_RECENT_KEY]: recent || {},
  });
}

// Serialise storage mutations only; network requests never hold this queue.
async function mutateDiagnosticStore(update) {
  const next = storeMutationPromise.then(async () => {
    const result = update(await readDiagnosticStore());
    await writeDiagnosticStore(result);
    return result.result;
  });
  storeMutationPromise = next.catch(() => {});
  return await next;
}

async function recordDiagnosticDelivery(delivery) {
  await globalThis.chrome?.storage?.local?.set?.({ [PLUGIN_DIAGNOSTICS_DELIVERY_KEY]: delivery });
}

async function markAttempt(id, now) {
  await mutateDiagnosticStore((store) => ({
    queue: store.queue.map((entry) => entry.id === id
      ? { ...entry, attempts: Number(entry.attempts || 0) + 1, lastAttemptAt: now } : entry),
    recent: store.recent,
  }));
}

async function removeQueuedReport(id) {
  await mutateDiagnosticStore((store) => ({
    queue: store.queue.filter((entry) => entry.id !== id),
    recent: store.recent,
  }));
}

function pruneRecentReports(recent, now) {
  return Object.fromEntries(
    Object.entries(recent || {})
      .filter(([, episode]) => readEpisode(episode)?.lastSeenAt > now - 24 * 60 * 60 * 1000)
      .sort((left, right) => (
        Number(readEpisode(right[1])?.lastSeenAt || 0) - Number(readEpisode(left[1])?.lastSeenAt || 0)
      ))
      .slice(0, RECENT_LIMIT),
  );
}

function readEpisode(value) {
  if (Number.isFinite(Number(value))) {
    const timestamp = Number(value);
    return timestamp > 0
      ? { firstSeenAt: timestamp, lastSeenAt: timestamp, occurrences: 1 }
      : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const firstSeenAt = Number(value.firstSeenAt || value.lastSeenAt || 0);
  const lastSeenAt = Number(value.lastSeenAt || firstSeenAt || 0);
  if (firstSeenAt <= 0 || lastSeenAt <= 0) return null;
  return {
    firstSeenAt,
    lastSeenAt,
    occurrences: Math.max(1, Math.min(999, Number(value.occurrences || 1))),
  };
}

function nextEpisode(episode, now) {
  return {
    firstSeenAt: Number(episode.firstSeenAt || now),
    lastSeenAt: now,
    occurrences: Math.min(999, Math.max(1, Number(episode.occurrences || 1)) + 1),
  };
}

function withEpisodeFields(fields, incidentKey, episode) {
  return {
    ...(fields || {}),
    incidentKey,
    occurrences: episode.occurrences,
    firstSeenAt: new Date(episode.firstSeenAt).toISOString(),
    lastSeenAt: new Date(episode.lastSeenAt).toISOString(),
  };
}

function updateQueuedEpisode(entries, dedupeKey, episode, latestPayload) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (entry?.dedupeKey !== dedupeKey || !entry.payload) return entry;
    return {
      ...entry,
      lastSeenAt: episode.lastSeenAt,
      occurrences: episode.occurrences,
      payload: {
        ...entry.payload,
        fields: withEpisodeFields({ ...entry.payload.fields, ...latestPayload?.fields }, dedupeKey, episode),
      },
    };
  });
}

async function resolveInstallationFingerprint() {
  if (!installationFingerprintPromise) {
    installationFingerprintPromise = (async () => {
      const installation = await ensureLifecycleInstallState();
      const installationId = String(installation.extensionInstanceId || '').trim();
      if (!installationId || !globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return '';
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`beav-plugin-diagnostic:${installationId}`),
      );
      return [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
    })().catch(() => '');
  }
  return await installationFingerprintPromise;
}

function compactNativeStatus(status = {}) {
  const bridge = status.handshake?.desktopBridge && typeof status.handshake.desktopBridge === 'object'
    ? status.handshake.desktopBridge
    : {};
  return {
    errorCode: safeToken(status.errorCode || '', ''),
    state: safeToken(status.state || 'unknown', 'unknown'),
    reconnectAttempt: Number.isInteger(Number(status.reconnectAttempt))
      ? Number(status.reconnectAttempt)
      : 0,
    error: redactText(status.error || '', 240),
    desktopBridgeConnected: bridge.connected === true,
    bridgeErrorCode: safeToken(bridge.errorCode || '', ''),
    bridgePhase: safeToken(bridge.phase || '', ''),
    bridgeReconnectAttempt: Math.max(0, Number(bridge.bridgeReconnectAttempt || 0)),
    descriptorAgeMs: Math.max(0, Number(bridge.details?.descriptorAgeMs || 0)),
    nativeHostVersion: safeToken(status.handshake?.appVersion || '', ''),
    desktopAppVersion: safeToken(bridge.appVersion || '', ''),
    expectedDisconnect: status.expectedDisconnect === true,
    nextRetryMs: Math.max(0, Number(status.nextRetryMs || 0)),
    lifecycle: status.lifecycle && typeof status.lifecycle === 'object'
      ? {
        reason: safeToken(status.lifecycle.reason || 'unknown', 'unknown'),
        expected: status.lifecycle.expected === true,
      }
      : null,
  };
}

function sanitizeValue(value, key = '', depth = 0) {
  if (depth > 3) return '[TRUNCATED]';
  if (isSensitiveKey(key)) return '[REDACTED_SECRET]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/url|link|origin|href|source/i.test(key)) return safeOrigin(value);
    return redactText(value, MAX_FIELD_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, key === 'connectionEvents' ? CONNECTION_EVENT_LIMIT : 12).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_FIELD_CHARS);
}

function isSensitiveKey(key) {
  return /authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh|content|html|markdown|body|payload|attachment|base64|binary|blob|raw|file|image|media|path/i.test(String(key || ''));
}

function redactText(value, maxChars) {
  return String(value ?? '')
    .replace(/data:(?:image|audio|video)\/[\w.+-]+;base64,[^\s]+/gi, '[REDACTED_DATA_URI]')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|secret|code|signature)=)[^&\s]+/gi, '$1[REDACTED_SECRET]')
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/var\/folders\/)[^\s,;]+/g, '[REDACTED_PATH]')
    .slice(0, maxChars);
}

function safeOrigin(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return '[REDACTED_URL]';
    return url.origin;
  } catch {
    return redactText(raw, 160);
  }
}

function safeToken(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 96);
  return normalized || fallback;
}

async function callChromePromise(value, fallback) {
  try {
    return await value;
  } catch {
    return fallback;
  }
}

function detectPlatform() {
  const ua = String(globalThis.navigator?.userAgent || '');
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

function detectBrowserFamily() {
  const userAgent = String(globalThis.navigator?.userAgent || '');
  if (/Edg\//i.test(userAgent)) return 'edge';
  if (/Brave\//i.test(userAgent) || globalThis.navigator?.brave) return 'brave';
  if (/Chromium\//i.test(userAgent)) return 'chromium';
  if (/Chrome\//i.test(userAgent)) return 'chrome';
  return 'unknown';
}

function createDiagnosticSendError(message) {
  const error = new Error(String(message || 'Plugin diagnostics submission failed'));
  error.retryable = true;
  return error;
}
