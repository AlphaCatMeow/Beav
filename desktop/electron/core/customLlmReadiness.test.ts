import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCustomReadinessSnapshot,
  buildCustomSourceSettings,
} from './customLlmReadiness.ts';

describe('custom LLM readiness', () => {
  it('preserves existing sources and persists a validated custom source as the active model', () => {
    const existingSource = {
      id: 'existing',
      name: 'Existing',
      presetId: 'openai',
      baseURL: 'https://existing.example/v1',
      apiKey: 'existing-key',
      models: ['existing-model'],
      modelsMeta: [{ id: 'existing-model' }],
      model: 'existing-model',
      protocol: 'openai',
    };

    const result = buildCustomSourceSettings(
      { ai_sources_json: JSON.stringify([existingSource]) },
      {
        baseURL: 'https://api.example.com/v1/',
        apiKey: ' test-key ',
        presetId: 'custom',
        protocol: 'openai',
        name: 'Example API',
      },
      [
        { id: 'chat-model', capabilities: ['text'] },
        { id: 'vision-model', capabilities: ['text', 'image'] },
      ],
    );

    const sources = JSON.parse(String(result.settings.ai_sources_json));
    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], existingSource);
    assert.deepEqual(result.source, {
      id: 'custom_api_setup',
      name: 'Example API',
      presetId: 'custom',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      models: ['chat-model', 'vision-model'],
      modelsMeta: [
        { id: 'chat-model', capabilities: ['text'] },
        { id: 'vision-model', capabilities: ['text', 'image'] },
      ],
      model: 'chat-model',
      protocol: 'openai',
    });
    assert.equal(result.settings.default_ai_source_id, 'custom_api_setup');
    assert.equal(result.settings.api_endpoint, 'https://api.example.com/v1');
    assert.equal(result.settings.api_key, 'test-key');
    assert.equal(result.settings.model_name, 'chat-model');
  });

  it('restores ready state from the persisted active custom source', () => {
    const snapshot = buildCustomReadinessSnapshot({
      default_ai_source_id: 'custom_api_setup',
      ai_sources_json: JSON.stringify([{
        id: 'custom_api_setup',
        name: 'Local API',
        presetId: 'ollama-local',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        models: ['qwen3'],
        model: 'qwen3',
        protocol: 'openai',
      }]),
    }, '2026-09-15T00:00:00.000Z');

    assert.deepEqual(snapshot, {
      ready: true,
      mode: 'local',
      sourceId: 'custom_api_setup',
      sourceName: 'Local API',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      protocol: 'openai',
      officialLoggedIn: false,
      canUseOfficial: false,
      canUseCustom: true,
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
  });

  it('uses the preferred discovered model when it is available', () => {
    const result = buildCustomSourceSettings(
      {},
      {
        baseURL: 'https://api.example.com/v1',
        apiKey: 'key',
        preferredModel: 'model-b',
      },
      [{ id: 'model-a' }, { id: 'model-b' }],
    );

    assert.equal(result.source.model, 'model-b');
    assert.equal(result.settings.model_name, 'model-b');
  });

  it('does not restore readiness from an official source in the public archive', () => {
    const snapshot = buildCustomReadinessSnapshot({
      default_ai_source_id: 'redbox_official_auto',
      ai_sources_json: JSON.stringify([{
        id: 'redbox_official_auto',
        name: 'Official',
        presetId: 'redbox-official',
        baseURL: 'https://official.example/v1',
        apiKey: 'official-token',
        model: 'official-model',
        protocol: 'openai',
      }]),
    });

    assert.equal(snapshot.ready, false);
  });

  it('requires an API key when restoring a remote custom source', () => {
    const snapshot = buildCustomReadinessSnapshot({
      default_ai_source_id: 'custom_api_setup',
      ai_sources_json: JSON.stringify([{
        id: 'custom_api_setup',
        name: 'Remote API',
        presetId: 'custom',
        baseURL: 'https://api.example.com/v1',
        apiKey: '',
        model: 'remote-model',
        protocol: 'openai',
      }]),
    });

    assert.equal(snapshot.ready, false);
  });
});
