import { expect } from 'chai';

import { UUPS_CONTRACTS } from '../../scripts/lib/proxy';
import { validateUpgradeSafety } from '../../scripts/lib/upgrades';

describe('Upgrade safety — OpenZeppelin validator [skip-on-coverage]', function () {
  this.timeout(300_000);

  it('every replaceable module passes, and the value layer is not upgradeable at all', () => {
    const output = validateUpgradeSafety({ quiet: true });
    expect(output).to.include('SUCCESS');

    for (const name of UUPS_CONTRACTS) {
      expect(output, name).to.include(`:${name}\n`);
    }

    for (const name of ['Treasury', 'Staking', 'STRAT', 'ProtocolAuthority']) {
      expect(output, `${name} must not be upgradeable`).to.not.include(
        `:${name}\n`,
      );
    }

    // The count depends on leftover build-info files, so it is not asserted.
    expect(output).to.match(
      /SUCCESS \(\d+ upgradeable contracts detected, \d+ passed, 0 failed\)/,
    );
  });
});
