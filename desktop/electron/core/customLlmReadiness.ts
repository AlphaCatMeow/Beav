import { normalizeApiBaseUrl } from './urlUtils.ts';

export type CustomAiProtocol = 'openai' | 'anthropic' | 'gemini';

type CustomSourceInput = {
  baseURL?: unknown;
  apiKey?: unknown;
  presetId?: unknown;
  protocol?: unknown;
  preferredModel?: unknown;
  name?: unknown;
};

type ModelInfo = {
  id?: unknown;
  capabilities?: unknown;
};

type CustomSource = {
  id: string;
  name: string;
  presetId: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  modelsMeta: Array<{ id: string; capabilities?: string[] }>;
  model: string;
  protocol: CustomAiProtocol;
};

const CUSTOM_SOURCE_ID = 'custom_api_setup';

const parseSources = (raw: unknown): Array<Record<string, unknown>> => {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
};

const normalizeProtocol = (value: unknown): CustomAiProtocol => {
  const protocol = String(value || '').trim().toLowerCase();
  return protocol === 'anthropic' || protocol === 'gemini' ? protocol : 'openai';
};

const isLocalSource = (source: Record<string, unknown>): boolean => {
  const presetId = String(source.presetId || '').toLowerCase();
  const baseURL = String(source.baseURL || '').toLowerCase();
  return presetId.includes('local') || /https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(baseURL);
};

const isOfficialSource = (source: Record<string, unknown>): boolean => {
  const id = String(source.id || '').trim().toLowerCase();
  const presetId = String(source.presetId || '').trim().toLowerCase();
  return id.startsWith('redbox_official') || presetId === 'redbox-official';
};

export function buildCustomSourceSettings(
  settings: Record<string, unknown>,
  input: CustomSourceInput,
  modelInfos: ModelInfo[],
): { settings: Record<string, unknown>; source: CustomSource } {
  const baseURL = normalizeApiBaseUrl(String(input.baseURL || ''));
  const apiKey = String(input.apiKey || '').trim();
  const modelsMeta = modelInfos
    .map((item) => {
      const id = String(item.id || '').trim();
      if (!id) return null;
      const capabilities = Array.isArray(item.capabilities)
        ? item.capabilities.map((value) => String(value || '').trim()).filter(Boolean)
        : undefined;
      return { id, ...(capabilities?.length ? { capabilities } : {}) };
    })
    .filter((item): item is { id: string; capabilities?: string[] } => Boolean(item));
  const models = Array.from(new Set(modelsMeta.map((item) => item.id)));

  if (!baseURL) throw new Error('Base URL is required');
  if (models.length === 0) throw new Error('未发现可用模型');

  const preferredModel = String(input.preferredModel || '').trim();
  const source: CustomSource = {
    id: CUSTOM_SOURCE_ID,
    name: String(input.name || '').trim() || 'Custom API',
    presetId: String(input.presetId || '').trim() || 'custom',
    baseURL,
    apiKey,
    models,
    modelsMeta,
    model: models.includes(preferredModel) ? preferredModel : models[0],
    protocol: normalizeProtocol(input.protocol),
  };
  const existingSources = parseSources(settings.ai_sources_json)
    .filter((item) => String(item.id || '') !== CUSTOM_SOURCE_ID);

  return {
    source,
    settings: {
      ai_sources_json: JSON.stringify([...existingSources, source]),
      default_ai_source_id: source.id,
      api_endpoint: source.baseURL,
      api_key: source.apiKey,
      model_name: source.model,
    },
  };
}

export function buildCustomReadinessSnapshot(
  settings: Record<string, unknown>,
  updatedAt = new Date().toISOString(),
) {
  const sourceId = String(settings.default_ai_source_id || '').trim();
  const source = parseSources(settings.ai_sources_json)
    .find((item) => String(item.id || '').trim() === sourceId);
  const baseURL = normalizeApiBaseUrl(String(source?.baseURL || ''));
  const model = String(source?.model || '').trim();
  const local = Boolean(source && isLocalSource(source));
  const apiKey = String(source?.apiKey || '').trim();
  const ready = Boolean(source && !isOfficialSource(source) && baseURL && model && (local || apiKey));

  return {
    ready,
    mode: local ? 'local' : 'custom',
    ...(!ready ? { reason: 'custom-source-not-configured' } : {}),
    ...(source ? {
      sourceId,
      sourceName: String(source.name || '').trim() || 'Custom API',
      baseURL,
      model,
      protocol: normalizeProtocol(source.protocol),
    } : {}),
    officialLoggedIn: false,
    canUseOfficial: false,
    canUseCustom: true,
    updatedAt,
  };
}
