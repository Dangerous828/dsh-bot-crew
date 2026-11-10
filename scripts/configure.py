#!/usr/bin/env python3
"""Configure a running dsh-superagent backend for the bot crew.

Reads the current settings blocks, then writes the roster, the Policy entry that admits the
owner, and the role models, bumping each block's revision so an optimistic save succeeds.
Never prints or stores a credential: the management API is loopback-only and needs no token.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PORT = os.environ.get('SUPERAGENT_PORT', '3082')
# The listener may be bound to the loopback or to a LAN address; try both, keeping the Host header on
# loopback because that is what the management fence accepts.
HOST_HEADER = '127.0.0.1:' + PORT
HEADERS = {'Host': HOST_HEADER, 'x-orchestrator-request': '1', 'Content-Type': 'application/json'}
BASE = None


def local_addresses():
    # Every IPv4 this machine holds: a backend bound to one specific address is reachable only through it.
    import socket
    found = {'127.0.0.1'}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    for target in ('192.168.31.1', '8.8.8.8'):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect((target, 80))
            found.add(probe.getsockname()[0])
        except OSError:
            pass
        finally:
            probe.close()
    return [address for address in found if address and not address.startswith('0.')]


def base_url():
    explicit = os.environ.get('SUPERAGENT_URL')
    if explicit:
        return explicit.rstrip('/')
    for address in local_addresses():
        candidate = 'http://' + address + ':' + PORT
        # curl, not urllib: the management server rejects urllib's default request shape while a
        # real client works, and this probe must match what the panel sends.
        probe = subprocess.run(
            ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3',
             '-H', 'Host: ' + HOST_HEADER, '-H', 'x-orchestrator-request: 1',
             candidate + '/orchestrator/api/settings'],
            capture_output=True, text=True)
        if probe.stdout.strip() == '200':
            return candidate
    raise SystemExit('no dsh-superagent answers on port ' + PORT + '; start it with scripts/dsh-superagent start')


# Change these two together: the model must exist in this profile's llm-pi-ai.providers.
PROVIDER = os.environ.get('CREW_PROVIDER', 'magpie')
MODEL = os.environ.get('CREW_MODEL', 'openconsole/deepseek-v4.1-flash')

BOTS = [
    {'bot_id': 'lead', 'name': '大哥', 'role': 'default',
     'persona': '简练，先应一声再决定。能转派就转派，拿不准就先问一句。',
     'memory_namespace': 'bot/lead'},
    {'bot_id': 'scribbler', 'name': '写手', 'role': 'member',
     'persona': '中文文案。克制，不堆词，先给一版再改。',
     'memory_namespace': 'bot/scribbler'},
    {'bot_id': 'coder', 'name': '码农', 'role': 'member',
     'persona': '写代码先看现有约定，改动小步、可回退，交付前自己跑一遍验证。',
     'memory_namespace': 'bot/coder'},
]


def call(method, path, body=None):
    # curl rather than urllib: the management server answers urllib's request shape with 502 while a real
    # client gets through, so the script speaks the same way the panel does.
    url = BASE + '/orchestrator/api/' + path
    command = ['curl', '-s', '-X', method, '--max-time', '20', '-w', '\n%{http_code}',
               '-H', 'Host: ' + HOST_HEADER, '-H', 'x-orchestrator-request: 1',
               '-H', 'Content-Type: application/json']
    if body is not None:
        command += ['-d', json.dumps(body, ensure_ascii=False)]
    result = subprocess.run(command + [url], capture_output=True, text=True)
    text, _, status = result.stdout.rpartition('\n')
    status = status.strip()
    text = text.strip()
    try:
        value = json.loads(text) if text else {}
    except ValueError:
        value = {'error': text[:200]}
    if status == '409':
        # A stale revision: the caller retries with a higher one.
        return {'conflict': True, 'error': value.get('error', 'conflict')}
    if status != '200':
        raise SystemExit(method + ' ' + path + ' -> ' + status + ': ' + str(value.get('error', text[:200])))
    return value


def live_revision(block):
    """Read the block's current revision. Blindly incrementing from 0 fails once a block has been saved 4 times."""
    settings = call('GET', 'settings')
    if block.startswith('source:'):
        for source in settings.get('sources', []):
            if source.get('id') == block[len('source:'):]:
                return source.get('revision')
        return None
    entry = (settings.get('blocks') or {}).get(block)
    return entry.get('revision') if isinstance(entry, dict) else None


def save(block, value, attempts=6):
    revision = live_revision(block) or 0
    for _ in range(attempts):
        result = call('PUT', 'settings/' + block, {'value': value, 'revision': revision})
        if not result.get('conflict'):
            return result
        # 409 说明别人（面板、另一个脚本）刚改过：重新读当前 revision，而不是从 0 盲加。
        live = live_revision(block)
        revision = live if isinstance(live, int) and live != revision else revision + 1
    raise SystemExit('could not save settings block ' + block)


def main():
    global BASE
    BASE = base_url()
    print('backend: ' + BASE)
    settings = call('GET', 'settings')
    policy = settings['blocks']['policy']['value']
    saved = save('source:team', {
        'enabled': True,
        'config': {
            'default_bot_id': 'lead',
            'bots': BOTS,
            'conversations': [{'id': 'main', 'listen': 'all', 'direct': False}],
            'pollSeconds': 3,
        },
    })
    print(f"source:team revision {saved['revision']}")

    # The owner must be admissible on the crew Source, or every message is recorded as not_a_member.
    allowed = {'id': 'owner', 'name': 'owner'}
    sources = dict(policy.get('sources') or {})
    sources['team'] = {**sources.get('team', {}), 'allowed': [allowed], 'admission': sources.get('team', {}).get('admission', {})}
    rules = policy.get('rules') or []
    if not any(rule['id'] == 'chat' for rule in rules):
        rules = rules + [{'id': 'chat', 'name': 'Conversation and small work', 'enabled': True,
                          'instruction': 'A request from a listed person in the bot crew conversation: answer it, or do '
                                         'the small concrete task it names on this machine, and report what was done.'}]
    saved = save('policy', {'rules': rules, 'sources': sources})
    print(f"policy revision {saved['revision']}")

    model = {'provider': PROVIDER, 'model': MODEL}
    # Both roles are pinned: a null model falls back to the host default, which a stale Session can keep using.
    saved = save('eval', {'mode': 'observe', 'timeoutSeconds': 180, 'model': model})
    print(f"eval revision {saved['revision']} (mode observe: it records what it would do)")
    saved = save('executor', {'model': model, 'maxWorkers': 3, 'directory': '', 'prepare': '', 'blockedCommands': []})
    print(f"executor revision {saved['revision']}")
    print(f'crew configured: {len(BOTS)} bots, default lead, model {PROVIDER}/{MODEL}')


if __name__ == '__main__':
    sys.exit(main())
