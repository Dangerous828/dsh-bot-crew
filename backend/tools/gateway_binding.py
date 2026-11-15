"""一支网关「属于谁」的判定：端口 + 状态目录这一对，没有缺省值。

拆成独立模块的理由是它必须能被**纯**测试：`tools/mobilegw` 一 import 就会建状态目录、写凭据、
开数据库，拿它当被测对象等于让测试去动生产目录。判定本身不需要任何 I/O，所以它单独住在这里。

2026-11-14 的事故链，每一环都对应下面一条规则：

    只给 DSH_HOME、没给 MOBILEGW_PORT
        → 网关落回缺省 8788 → 撞上 launchd 托管的生产网关 → Errno 48
        → 「先杀掉占端口的进程」 → `pkill -f backend/tools/mobilegw` 是路径子串
        → 生产网关被带走两次

所以：端口不是缺省值而是声明（第 1 条）；生产端口不属于任何测试（第 2 条）。
"""

from __future__ import annotations

import os

PRODUCTION_PORT = 8788
PRODUCTION_STATE = os.path.join(os.path.expanduser('~'), '.dsh', 'state', 'superagent')


def binding_problem(port_text: str, state: str,
                    production_port: int = PRODUCTION_PORT,
                    production_state: str = PRODUCTION_STATE) -> str | None:
    """Why this (port, state directory) pair may not start, or None when it may.

    `port_text` 是环境变量原文（可能为空、可能是垃圾）：这里只判「能不能起」，不替调用方猜一个端口。
    """
    if not port_text:
        return ('MOBILEGW_PORT is required: the port says which gateway this is, so there is no '
                'default to fall back on. Set MOBILEGW_PORT to a port of its own (state directory %s).'
                % state)
    try:
        port = int(port_text)
    except (TypeError, ValueError):
        return 'MOBILEGW_PORT is not a number: %r' % (port_text,)
    if not 1 <= port <= 65535:
        return 'MOBILEGW_PORT is out of range: %d' % port
    same_state = os.path.realpath(state) == os.path.realpath(production_state)
    if port == production_port and not same_state:
        # 8788 + 生产状态目录 = 生产那一份本身（launchd 的 plist 就是这么起的），唯一合法组合。
        # 8788 + 别的目录 = 一支借了生产端口的第二个网关：它自己绑不上，只会把调用方引到
        # 「先清理端口」那条路上。
        return ('refusing to start: %d belongs to the production gateway (%s). This instance was '
                'pointed at %s, so it would be a second gateway on the same port. '
                'Give it a port of its own.' % (port, production_state, state))
    return None


def parse_port(port_text: str) -> int:
    """The port, for callers that already ran `binding_problem` and got None."""
    return int(port_text)
