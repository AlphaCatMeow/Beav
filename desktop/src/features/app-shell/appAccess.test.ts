import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAppAccess } from './appAccess.ts';

describe('resolveAppAccess', () => {
  it('allows an anonymous archive user into the workbench when custom LLM readiness is ready', () => {
    assert.equal(resolveAppAccess({
      requireOfficialAuth: false,
      officialAuthBootstrapped: true,
      officialAuthStatus: 'anonymous',
      officialAuthLoggedIn: false,
      llmReadinessBootstrapped: true,
      llmReady: true,
    }), 'workbench');
  });

  it('shows the custom LLM setup while readiness is not ready without waiting for official auth', () => {
    assert.equal(resolveAppAccess({
      requireOfficialAuth: false,
      officialAuthBootstrapped: false,
      officialAuthStatus: 'restoring',
      officialAuthLoggedIn: false,
      llmReadinessBootstrapped: true,
      llmReady: false,
    }), 'llm-setup');
  });
});
