"""网关启动隔离：没给独立端口就不许起，占了生产端口也不许起，起来之后要留下 PID 所有权。

这三条来自 2026-11-14 的事故：测试台架只给了 `DSH_HOME` 没给 `MOBILEGW_PORT`，网关静默落回
默认 `8788`、撞上 launchd 托管的生产网关拿到 `Errno 48`；随后的修法是「先杀掉占端口的网关」，
pattern 写成路径子串，把生产那份一起带走了两次。

所以这里钉的不是「端口号是多少」，而是**端口归属**：
- 独立端口 + 独立状态目录 = 一次合法的台架启动；
- 只给状态目录不给端口 = 意图不明，拒绝启动（而不是猜 8788）；
- 台架拿生产端口 = 拒绝启动（而不是先杀再抢）。

启动行里不许出现凭据值：事故里那行 `token=<值>` 至今还躺在 0644 的历史日志里。
"""
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
import urllib.request

TOOLS = pathlib.Path(__file__).resolve().parent
GATEWAY = TOOLS / 'mobilegw'
PRODUCTION_PORT = 8788


def free_port() -> int:
    """A port nobody holds right now. Closed before returning, so the gateway can take it."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def run_gateway(env_extra: dict, timeout: float = 6.0) -> subprocess.CompletedProcess:
    """Start the gateway exactly as a caller would, and never leave it running.

    The timeout is the safety net for the case this test exists to catch: a gateway that should have
    refused starts serving instead. Killing it is safe — it is our own child, spawned here.
    """
    env = {key: value for key, value in os.environ.items()
           if key not in ('MOBILEGW_PORT', 'MOBILEGW_STATE', 'MOBILEGW_HOST', 'MOBILEGW_CONV', 'DSH_HOME')}
    env.update(env_extra)
    env['PYTHONUNBUFFERED'] = '1'
    child = subprocess.Popen([sys.executable, str(GATEWAY)], env=env, text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        out, err = child.communicate()
    return subprocess.CompletedProcess(child.args, child.returncode, out, err)


class StartupPortGateTest(unittest.TestCase):
    """端口与状态目录必须成对给出，且不许指向生产。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = self.temp.name
        self.state = os.path.join(self.home, 'state', 'superagent')

    def tearDown(self):
        self.temp.cleanup()

    def test_fixture_state_without_port_refuses_instead_of_guessing_8788(self):
        # 事故第一条命令的形态：DSH_HOME 给了，MOBILEGW_PORT 没给。
        done = run_gateway({'DSH_HOME': self.home})
        self.assertEqual(done.returncode, 2, 'must fail fast, not fall back to the default port')
        self.assertIn('MOBILEGW_PORT', done.stderr)
        self.assertIn(self.state, done.stderr, 'the message must name the state directory it was asked to use')
        self.assertNotIn('Errno 48', done.stderr, 'refusing up front is not the same as losing a race for 8788')
        self.assertFalse(os.path.exists(os.path.join(self.state, 'mobilegw.owner')))

    def test_fixture_refuses_the_production_port_even_when_asked_explicitly(self):
        done = run_gateway({'DSH_HOME': self.home, 'MOBILEGW_PORT': str(PRODUCTION_PORT)})
        self.assertEqual(done.returncode, 2)
        self.assertIn(str(PRODUCTION_PORT), done.stderr)
        self.assertIn('production', done.stderr)
        self.assertIn(self.state, done.stderr)

    def test_dedicated_port_and_state_start_and_claim_their_pid(self):
        port = free_port()
        # 先起、探活、再收：证明这条路径是能用的，否则「拒绝」只是把台架整体弄坏。
        env = {key: value for key, value in os.environ.items()
               if key not in ('MOBILEGW_PORT', 'MOBILEGW_STATE', 'MOBILEGW_HOST', 'MOBILEGW_CONV', 'DSH_HOME')}
        env.update({'DSH_HOME': self.home, 'MOBILEGW_PORT': str(port), 'MOBILEGW_HOST': '127.0.0.1'})
        env['PYTHONUNBUFFERED'] = '1'
        child = subprocess.Popen([sys.executable, str(GATEWAY)], env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            line = child.stdout.readline()
            self.assertIn('mobilegw on 127.0.0.1:%d' % port, line)
            owner = json.loads(pathlib.Path(self.state, 'mobilegw.owner').read_text())
            self.assertEqual(owner['pid'], child.pid)
            self.assertEqual(owner['port'], port)
            self.assertEqual(os.path.realpath(owner['state']), os.path.realpath(self.state))
            self.assertEqual(owner['parent'], os.getpid(), 'the record must say which process spawned it')
            self.assertNotIn('managed', owner, 'XPC_SERVICE_NAME is inherited; it cannot prove supervision')
        finally:
            child.terminate()
            child.communicate(timeout=10)

    def test_startup_line_never_carries_the_credential_value(self):
        port = free_port()
        token_file = pathlib.Path(self.state, 'mobilegw.token')
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text('known-fixture-credential-value\n')
        done = run_gateway({'DSH_HOME': self.home, 'MOBILEGW_PORT': str(port)}, timeout=3.0)
        self.assertNotIn('known-fixture-credential-value', done.stdout)
        self.assertNotIn('known-fixture-credential-value', done.stderr)
        # 需要知道这份网关用的是哪一支凭据，但那应该是路径，不是值。
        self.assertIn(str(token_file), done.stdout)

    def test_owner_record_never_carries_the_credential_value(self):
        port = free_port()
        token_file = pathlib.Path(self.state, 'mobilegw.token')
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text('known-fixture-credential-value\n')
        env = {key: value for key, value in os.environ.items()
               if key not in ('MOBILEGW_PORT', 'MOBILEGW_STATE', 'MOBILEGW_HOST', 'MOBILEGW_CONV', 'DSH_HOME')}
        env.update({'DSH_HOME': self.home, 'MOBILEGW_PORT': str(port)})
        env['PYTHONUNBUFFERED'] = '1'
        child = subprocess.Popen([sys.executable, str(GATEWAY)], env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdout.readline()
            recorded = pathlib.Path(self.state, 'mobilegw.owner').read_text()
            self.assertNotIn('known-fixture-credential-value', recorded)
        finally:
            child.terminate()
            child.communicate(timeout=10)


class OccupiedPortTest(unittest.TestCase):
    """端口被别人占着时，台架要报错退出，绝不替对方做决定。"""

    def test_refuses_a_port_someone_else_is_listening_on(self):
        with tempfile.TemporaryDirectory() as home:
            holder = socket.socket()
            holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            holder.bind(('127.0.0.1', 0))
            holder.listen(1)
            port = holder.getsockname()[1]
            try:
                done = run_gateway({'DSH_HOME': home, 'MOBILEGW_PORT': str(port)}, timeout=6.0)
                # 该端口属于别人：网关自己不抢，也不去杀那个进程。
                self.assertNotEqual(done.returncode, 0)
                self.assertIn('in use', (done.stderr + done.stdout).lower())
                self.assertEqual(holder.fileno() >= 0, True)
                # 持有者仍然活着且仍在监听 —— 这就是「失败不得清理未知进程」的最小证据。
                probe = socket.socket()
                try:
                    self.assertEqual(probe.connect_ex(('127.0.0.1', port)), 0)
                finally:
                    probe.close()
            finally:
                holder.close()


class BenchWrapperTest(unittest.TestCase):
    """可复用台架：显式端口 + 独立状态目录 + 只回收自己那个 pid。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.wrapper = TOOLS.parent.parent / 'scripts' / 'gateway-fixture.sh'

    def tearDown(self):
        self.temp.cleanup()

    def run_wrapper(self, *args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
        env = {key: value for key, value in os.environ.items()
               if key not in ('MOBILEGW_PORT', 'MOBILEGW_STATE', 'MOBILEGW_HOST', 'DSH_HOME')}
        return subprocess.run(['sh', str(self.wrapper), *args], env=env, text=True,
                              capture_output=True, timeout=timeout)

    def test_wrapper_exists_and_explains_itself(self):
        self.assertTrue(self.wrapper.exists(), 'the bench needs one shared launcher, not three copies')
        done = self.run_wrapper('--help')
        self.assertEqual(done.returncode, 0)
        self.assertIn('MOBILEGW_PORT', done.stdout)

    def test_wrapper_start_claims_its_own_pid_and_stops_only_that_one(self):
        home = self.root / 'fixture-home'
        done = self.run_wrapper('start', '--home', str(home), '--print-port')
        self.assertEqual(done.returncode, 0, done.stderr)
        port = int(done.stdout.strip().splitlines()[-1])
        self.assertNotEqual(port, PRODUCTION_PORT)
        pid_file = home / 'gateway.pid'
        self.assertTrue(pid_file.exists())
        pid = int(pid_file.read_text().strip())
        self.assertGreater(pid, 0)
        owner = json.loads((home / 'state' / 'superagent' / 'mobilegw.owner').read_text())
        self.assertEqual(owner['pid'], pid)
        stop = self.run_wrapper('stop', '--home', str(home))
        self.assertEqual(stop.returncode, 0, stop.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_wrapper_refuses_a_port_held_by_a_stranger_and_leaves_it_alive(self):
        home = self.root / 'fixture-home'
        holder = socket.socket()
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(('127.0.0.1', 0))
        holder.listen(1)
        port = holder.getsockname()[1]
        try:
            done = self.run_wrapper('start', '--home', str(home), '--port', str(port))
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('in use', (done.stderr + done.stdout).lower())
            self.assertFalse((home / 'gateway.pid').exists(), 'a refused start must not record a pid to stop')
            probe = socket.socket()
            try:
                self.assertEqual(probe.connect_ex(('127.0.0.1', port)), 0)
            finally:
                probe.close()
        finally:
            holder.close()

    def test_wrapper_refuses_the_production_port(self):
        home = self.root / 'fixture-home'
        done = self.run_wrapper('start', '--home', str(home), '--port', str(PRODUCTION_PORT))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('production', done.stderr)

    def test_stop_ignores_a_pid_file_whose_pid_now_belongs_to_someone_else(self):
        # PID 会被系统回收：拿旧 pid 去 kill，杀的是别人的新进程。所有权记录必须带启动时刻。
        home = self.root / 'fixture-home'
        home.mkdir(parents=True, exist_ok=True)
        stranger = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            (home / 'gateway.pid').write_text('%d\n' % stranger.pid)
            (home / 'gateway.pid.meta').write_text(json.dumps({'pid': stranger.pid, 'started_at': 0}))
            done = self.run_wrapper('stop', '--home', str(home))
            self.assertNotEqual(done.returncode, 0, 'a recycled pid must not be signalled')
            self.assertIn('不是本台架当初那个进程', done.stderr + done.stdout)
            self.assertIsNone(stranger.poll(), 'the stranger must still be running')
        finally:
            stranger.kill()
            stranger.wait(timeout=10)

    def test_scripts_do_not_signal_by_pattern_or_port(self):
        """仓库里任何台架都不许按路径/端口批量杀进程 —— 这正是事故的形态。"""
        offenders = []
        for script in (TOOLS.parent.parent / 'scripts').glob('test-*.sh'):
            text = script.read_text()
            for match in re.finditer(r'\b(pkill|killall|fuser)\b', text):
                offenders.append('%s:%d %s' % (script.name, text[:match.start()].count('\n') + 1, match.group()))
        self.assertEqual(offenders, [], 'use the pid this task owns, never a pattern or a port')


class CollectionIntegrityTest(unittest.TestCase):
    """`unittest.main()` 必须在文件最末尾，否则它之后定义的测试类直跑时不会被收集。

    这条钉的不是某个具体行为，而是「测试本身必须全都被跑到」：本文件曾把 `unittest.main()` 放在
    中部，`python3 test_gateway_isolation.py` 只跑 12/29，后四组类（判定/所有权/台架配方/热轮换）
    静默不执行 —— 而人还会以为「绿了」。静默少跑测试和静默吞异常一样是洞。
    """

    def test_unittest_main_is_the_last_statement_and_collects_every_class(self):
        source = pathlib.Path(__file__).read_text().splitlines()
        indexes = [i for i, line in enumerate(source) if re.match(r'^\s*unittest\.main\(', line)]
        self.assertEqual(len(indexes), 1, 'there must be exactly one unittest.main() call')
        last_code = max(i for i, line in enumerate(source)
                        if line.strip() and not line.strip().startswith('#'))
        self.assertEqual(indexes[0], last_code, 'unittest.main() must be the final statement in the file')
        # 名字上双重保险：文件里所有 TestCase 子类都能被 loader 收集到。
        import unittest as _unittest
        loader = _unittest.TestLoader()
        suite = loader.loadTestsFromName(__name__)
        collected = suite.countTestCases()
        self.assertGreaterEqual(collected, 29,
                                'every test class must be collected, not just the ones before unittest.main()')


class BindingRuleTest(unittest.TestCase):
    """判定本身是纯函数，所以能逐条钉死，而不必起进程或碰生产目录。"""

    def setUp(self):
        sys.path.insert(0, str(TOOLS))
        import gateway_binding
        self.rules = gateway_binding

    def test_missing_port_is_refused_and_the_message_names_the_state_directory(self):
        problem = self.rules.binding_problem('', '/tmp/bench/state/superagent')
        self.assertIn('MOBILEGW_PORT', problem)
        self.assertIn('/tmp/bench/state/superagent', problem)

    def test_production_port_with_a_foreign_state_directory_is_refused(self):
        problem = self.rules.binding_problem('8788', '/tmp/bench/state/superagent')
        self.assertIn('production', problem)
        self.assertIn('/tmp/bench/state/superagent', problem)

    def test_production_pair_itself_is_the_one_legitimate_combination(self):
        # 生产网关就是 8788 + 生产状态目录。挡掉它自己会让 launchd 的 KeepAlive 陷进
        # 「起不来—重启—起不来」，所以这条组合必须放行。
        production_state = self.rules.PRODUCTION_STATE
        self.assertIsNone(self.rules.binding_problem(str(self.rules.PRODUCTION_PORT), production_state))

    def test_a_dedicated_port_on_a_dedicated_directory_is_allowed(self):
        self.assertIsNone(self.rules.binding_problem('43510', '/tmp/bench/state/superagent'))

    def test_junk_and_out_of_range_ports_are_refused(self):
        for text in ('abc', '0', '70000', '-1', ' '):
            self.assertIsNotNone(self.rules.binding_problem(text, '/tmp/bench/state/superagent'), text)


def load_service_script():
    """`backend/scripts/dsh-superagent` 是个无扩展名的脚本，按源码加载才能测它里面的判定。"""
    import importlib.machinery
    import importlib.util
    path = TOOLS.parent / 'scripts' / 'dsh-superagent'
    loader = importlib.machinery.SourceFileLoader('dsh_superagent_under_test', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class OwnershipRecordTest(unittest.TestCase):
    """`ensure_gateway` 只许回收「所有权记录对得上」的那一个进程。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = pathlib.Path(self.temp.name) / 'state' / 'superagent'
        self.state.mkdir(parents=True)
        self.script = load_service_script()

    def tearDown(self):
        self.temp.cleanup()

    def write_record(self, **overrides):
        record = {'pid': os.getpid(), 'parent': 1, 'port': 41000,
                  'state': str(self.state.resolve()), 'started_at': 1}
        record.update(overrides)
        (self.state / 'mobilegw.owner').write_text(json.dumps(record))

    def test_a_matching_record_is_recognised(self):
        self.write_record()
        self.assertTrue(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_a_missing_record_is_not_ours(self):
        self.assertFalse(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_a_record_for_another_pid_is_not_ours(self):
        self.write_record(pid=os.getpid() + 1)
        self.assertFalse(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_a_record_for_another_port_is_not_ours(self):
        self.write_record(port=41001)
        self.assertFalse(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_a_record_for_another_state_directory_is_not_ours(self):
        self.write_record(state='/tmp/somewhere-else')
        self.assertFalse(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_a_corrupt_record_is_not_ours(self):
        (self.state / 'mobilegw.owner').write_text('not json')
        self.assertFalse(self.script.owns_gateway(os.getpid(), 41000, str(self.state)))

    def test_ensure_gateway_refuses_a_listener_it_does_not_own_and_leaves_it_running(self):
        """命令行里带 mobilegw 只是必要条件：没有所有权记录就报错，不发信号。"""
        decoy_dir = pathlib.Path(self.temp.name) / 'decoy'
        decoy_dir.mkdir()
        decoy = decoy_dir / 'mobilegw_decoy.py'
        decoy.write_text(
            'import socket, sys, time\n'
            'sock = socket.socket()\n'
            'sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n'
            'sock.bind(("127.0.0.1", int(sys.argv[1])))\n'
            'sock.listen(1)\n'
            'print("ready", flush=True)\n'
            'time.sleep(60)\n')
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        child = subprocess.Popen([sys.executable, str(decoy), str(port)], text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with unittest.mock.patch.dict(os.environ, {'MOBILEGW_PORT': str(port),
                                                       'MOBILEGW_STATE': str(self.state)}, clear=False):
                with self.assertRaises(RuntimeError) as caught:
                    self.script.ensure_gateway(None)
            self.assertIn("not this crew's gateway", str(caught.exception))
            self.assertIsNone(child.poll(), 'a process we do not own must still be running')
        finally:
            child.kill()
            child.wait(timeout=10)
            child.stdout.close()


class BenchLaunchRecipeTest(unittest.TestCase):
    """台架启动网关时必须显式给端口与独立状态目录；没有一处可以靠缺省值。

    这条是把「约定」变成「机制」的那一步：三个台架各自手写启动命令，靠注释提醒是防不住下一次的
    （2026-11-14 就是有人照着旧注释只给了 DSH_HOME）。
    """

    def setUp(self):
        self.scripts = sorted((TOOLS.parent.parent / 'scripts').glob('test-*.sh'))

    def launches(self):
        """每个真正 spawn 网关的地方，连同它周围那段启动环境。"""
        found = []
        for script in self.scripts:
            lines = script.read_text().splitlines()
            for index, line in enumerate(lines):
                if 'python3 "$GW"' in line or "python3 \"$GW\"" in line:
                    window = '\n'.join(lines[max(0, index - 8):index + 1])
                    found.append((script.name, index + 1, window))
        return found

    def test_every_bench_launches_the_gateway_with_an_explicit_port(self):
        launches = self.launches()
        self.assertGreaterEqual(len(launches), 3, 'the three benches should still be spawning the gateway')
        for name, line, window in launches:
            self.assertIn('MOBILEGW_PORT=', window,
                          '%s:%d spawns the gateway without an explicit MOBILEGW_PORT' % (name, line))

    def test_every_bench_launches_the_gateway_on_its_own_state_directory(self):
        for name, line, window in self.launches():
            self.assertTrue('MOBILEGW_STATE=' in window or 'DSH_HOME=' in window,
                            '%s:%d spawns the gateway without its own state directory' % (name, line))

    def test_no_bench_can_reach_the_production_port(self):
        for name, line, window in self.launches():
            self.assertNotIn('MOBILEGW_PORT=8788', window.replace(' ', ''),
                             '%s:%d hard-codes the production port' % (name, line))


class HotRotationTest(unittest.TestCase):
    """换掉凭据文件就生效：旧值立刻失效、新值立刻通行，全程不重启网关。

    这条决定了「日志泄露后的轮换」到底能不能在**不重启生产网关**的前提下做掉。原先是模块级常量，
    换文件要等到重启才生效 —— 那就等于把轮换和重启绑在一起，而重启生产网关是明确不许做的动作。
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temp.name)
        self.state = self.home / 'state' / 'superagent'
        self.state.mkdir(parents=True)
        (self.state / 'mobilegw.token').write_text('first-credential\n')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        env = {key: value for key, value in os.environ.items()
               if key not in ('MOBILEGW_PORT', 'MOBILEGW_STATE', 'MOBILEGW_HOST', 'DSH_HOME')}
        env.update({'DSH_HOME': str(self.home), 'MOBILEGW_PORT': str(self.port), 'PYTHONUNBUFFERED': '1'})
        self.child = subprocess.Popen([sys.executable, str(GATEWAY)], env=env, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.child.stdout.readline()
        self.base = 'http://127.0.0.1:%d' % self.port

    def tearDown(self):
        self.child.terminate()
        try:
            self.child.communicate(timeout=10)
        finally:
            self.child.stdout.close()
            self.child.stderr.close()
            self.temp.cleanup()

    def status(self, token: str) -> int:
        request = urllib.request.Request(self.base + '/timeline', headers={'X-GW-Token': token})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_old_credential_stops_working_and_the_new_one_works_without_a_restart(self):
        self.assertEqual(self.status('first-credential'), 200)
        (self.state / 'mobilegw.token').write_text('second-credential\n')
        self.assertEqual(self.status('first-credential'), 401, 'the rotated-out value must stop working')
        self.assertEqual(self.status('second-credential'), 200, 'the new value must work immediately')
        self.assertIsNone(self.child.poll(), 'the gateway must still be the same process')

    def test_a_missing_file_does_not_lock_out_the_paired_devices(self):
        # 轮换的做法是「写新文件再原子替换」，中间会有一瞬没有这个路径。那一瞬不该让所有手机掉线。
        self.assertEqual(self.status('first-credential'), 200)
        (self.state / 'mobilegw.token').unlink()
        self.assertEqual(self.status('first-credential'), 200)


if __name__ == '__main__':
    # 必须留在文件最后：`unittest.main()` 一旦提前执行，它后面定义的测试类就不会被收集，直跑时会
    # 静默少跑一批（本文件曾因它放在中间而只跑 12/29）。收集完整性本身由 test_all_test_classes_are_collected 钉住。
    unittest.main(verbosity=2)
