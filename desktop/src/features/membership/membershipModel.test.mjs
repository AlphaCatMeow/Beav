import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));

let server;
let membershipModel;
let entitlementKeys;

before(async () => {
  server = await createServer({
    root: desktopRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  membershipModel = await server.ssrLoadModule('/src/features/membership/membershipModel.ts');
  entitlementKeys = await server.ssrLoadModule('/src/features/membership/entitlementKeys.ts');
});

after(async () => {
  await server?.close();
});

describe('temporary default founder sponsor membership', () => {
  it('presents an anonymous app state as an active founder sponsor', () => {
    const state = membershipModel.normalizeMembershipState(null);

    assert.equal(state.active, true);
    assert.equal(state.founderActive, true);
    assert.equal(state.plan, 'founder_sponsor');
    assert.deepEqual(membershipModel.resolveFounderSponsorState(null), {
      active: true,
      labelKey: 'layout.founderSponsor.memberLabel',
    });
  });

  it('grants both space creation and another member entitlement by default', () => {
    const state = membershipModel.normalizeMembershipState(null);
    const { ENTITLEMENTS } = entitlementKeys;

    assert.equal(membershipModel.canUseEntitlement(state, ENTITLEMENTS.spacesCreate), true);
    assert.equal(membershipModel.canUseEntitlement(state, ENTITLEMENTS.supportPriority), true);
  });

  it('overrides denied member entitlements while the temporary default is enabled', () => {
    const { ENTITLEMENTS } = entitlementKeys;
    const state = membershipModel.normalizeMembershipState({
      entitlements: {
        [ENTITLEMENTS.spacesCreate]: false,
        [ENTITLEMENTS.spacesCreateUnlimited]: false,
        [ENTITLEMENTS.supportPriority]: false,
      },
    });

    assert.equal(membershipModel.canUseEntitlement(state, ENTITLEMENTS.spacesCreate), true);
    assert.equal(membershipModel.canUseEntitlement(state, ENTITLEMENTS.supportPriority), true);
  });
});
