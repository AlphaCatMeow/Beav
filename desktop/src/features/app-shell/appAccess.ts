export type AppAccessTarget = 'official-checking' | 'official-login' | 'llm-checking' | 'llm-setup' | 'workbench';

export function resolveAppAccess(input: {
  requireOfficialAuth: boolean;
  officialAuthBootstrapped: boolean;
  officialAuthStatus: string;
  officialAuthLoggedIn: boolean;
  llmReadinessBootstrapped: boolean;
  llmReady: boolean;
}): AppAccessTarget {
  const officialAuthPending = !input.officialAuthBootstrapped
    || input.officialAuthStatus === 'restoring'
    || input.officialAuthStatus === 'refreshing';

  if (input.requireOfficialAuth && officialAuthPending) return 'official-checking';
  if (input.requireOfficialAuth && !input.officialAuthLoggedIn) return 'official-login';
  if (!input.llmReadinessBootstrapped) return 'llm-checking';
  if (!input.llmReady) return 'llm-setup';
  return 'workbench';
}
