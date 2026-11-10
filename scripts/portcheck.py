#!/usr/bin/env python3
"""The two ports a crew derives from its state directory.

Neither is chosen by hand, and both have to agree with the code that uses them:

    gateway  scripts/dsh-superagent `state_dir_identity`   the default directory keeps 8788,
                                                            every other one is 18800 + digest % 100
    lan      backend/src/app/lan-server.ts `lanPort`       20000 + a 31-based rolling hash % 40000

A second crew on the same machine lands somewhere else on both, which is the point: one machine can run
two, and a hand-copied port number would describe only the first. Kept as one file so a reader can see the
two rules side by side instead of grepping two languages.
"""

from __future__ import annotations

import pathlib
import sys


def gateway(state_dir: str) -> int:
    resolved = pathlib.Path(state_dir).expanduser().resolve()
    if resolved == (pathlib.Path.home() / '.dsh' / 'state' / 'superagent').resolve():
        return 8788
    return 18800 + sum(ord(character) for character in str(resolved)) % 100


def lan(state_dir: str) -> int:
    digest = 0
    for character in state_dir:
        digest = (digest * 31 + ord(character)) % 100_000
    return 20_000 + digest % 40_000


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ('gateway', 'lan'):
        print(f'usage: {argv[0]} gateway|lan <stateDir>', file=sys.stderr)
        return 2
    print((gateway if argv[1] == 'gateway' else lan)(argv[2]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
