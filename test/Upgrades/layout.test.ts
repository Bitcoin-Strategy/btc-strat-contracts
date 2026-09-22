import { expect } from 'chai';

import {
  assertLayoutCompatible,
  getContractLayout,
} from '../../scripts/lib/upgrades';
import { UUPS_CONTRACTS } from '../../scripts/lib/proxy';

describe('Upgrade safety — storage layout tooling [skip-on-coverage]', function () {
  this.timeout(300_000);

  it('extracts an upgrade-safe layout for every replaceable module', () => {
    for (const name of UUPS_CONTRACTS) {
      const { layout } = getContractLayout(name);
      expect(layout.storage.length, name).to.be.greaterThan(0);
      assertLayoutCompatible(name, layout, layout);
    }
  });

  it('accepts the append-only V2 mock and rejects layouts that drop or retype a variable', () => {
    const bonding = getContractLayout('Bonding').layout;
    const bondingV2 = getContractLayout('BondingV2Mock', {
      assertSafe: false,
    }).layout;
    assertLayoutCompatible('Bonding', bonding, bondingV2);

    const dropped = JSON.parse(JSON.stringify(bonding));
    dropped.storage.splice(0, 1);
    expect(() => assertLayoutCompatible('Bonding', bonding, dropped)).to.throw(
      /not compatible/,
    );

    const retyped = JSON.parse(JSON.stringify(bonding));
    retyped.storage[retyped.storage.length - 1].type = 't_uint256';
    expect(() => assertLayoutCompatible('Bonding', bonding, retyped)).to.throw(
      /not compatible/,
    );
  });
});
