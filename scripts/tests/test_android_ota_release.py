import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'android-ota-release'
loader = importlib.machinery.SourceFileLoader('android_ota_release', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
release = importlib.util.module_from_spec(spec)
loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / 'published'
        self.apk = self.home / 'candidate.apk'
        self.apk.write_bytes(b'opaque signed apk bytes')

    def manifest(self, code=2):
        digest = release.sha256(self.apk)
        return {'schemaVersion': 1, 'packageName': release.PACKAGE, 'versionCode': code,
                'versionName': '0.2.0', 'buildId': 'test', 'minSdk': 26, 'sha256': digest,
                'size': self.apk.stat().st_size, 'signerSha256': release.SIGNER,
                'apkPath': f'/updates/android/{code}/{digest}.apk'}

    def test_versions_are_strictly_increasing(self):
        self.assertEqual(2, release.next_code(None))
        self.assertEqual(4, release.next_code({'versionCode': 3}))
        for code in [0, 1, 3, True, release.MAX_CODE + 1]:
            with self.assertRaises(ValueError):
                release.next_code({'versionCode': 3}, code)

    def test_corrupt_current_manifest_does_not_restart_versioning(self):
        self.root.mkdir()
        for value in [{'schemaVersion': 1, 'packageName': release.PACKAGE, 'versionCode': True},
                      {'schemaVersion': 1, 'packageName': 'other.app', 'versionCode': 2}]:
            (self.root / 'manifest.json').write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                release.read_latest(self.root)

    def test_origin_has_no_credentials_path_or_insecure_scheme(self):
        self.assertEqual('https://crew.kentonnie.top', release.public_origin('https://crew.kentonnie.top/'))
        for value in ['http://crew.kentonnie.top', 'https://token@crew.kentonnie.top',
                      'https://crew.kentonnie.top/x', 'https://crew.kentonnie.top?q=1',
                      'https://crew.kentonnie.top#x', 'https://crew.kentonnie.top:99999']:
            with self.assertRaises(ValueError):
                release.public_origin(value)

    def test_expected_crew_matches_existing_deployment(self):
        self.assertEqual('0kvcc5t', release.crew_fingerprint('/Users/cpuser/.dsh/state/superagent'))

    def test_new_pointer_follows_complete_immutable_file(self):
        manifest = self.manifest()
        path = release.publish(self.root, self.apk, manifest)
        self.assertEqual(self.apk.read_bytes(), path.read_bytes())
        self.assertEqual(manifest, release.read_latest(self.root))
        self.apk.write_bytes(b'another signed release')
        newer = self.manifest(3)
        release.publish(self.root, self.apk, newer)
        self.assertEqual(newer, release.read_latest(self.root))
        self.assertEqual(b'opaque signed apk bytes', path.read_bytes())
        with self.assertRaises(ValueError):
            release.publish(self.root, self.apk, newer)

    def test_changed_candidate_never_changes_live_pointer(self):
        old = self.manifest()
        release.publish(self.root, self.apk, old)
        newer = self.manifest(3)
        self.apk.write_bytes(b'changed after verification')
        with self.assertRaises(ValueError):
            release.publish(self.root, self.apk, newer)
        self.assertEqual(old, release.read_latest(self.root))

    def test_immutable_conflict_and_path_escape_are_blocked(self):
        manifest = self.manifest()
        path = self.root / '2' / (manifest['sha256'] + '.apk')
        path.parent.mkdir(parents=True)
        path.write_bytes(b'wrong bytes')
        with self.assertRaises(ValueError):
            release.publish(self.root, self.apk, manifest)
        self.assertFalse((self.root / 'manifest.json').exists())
        manifest['apkPath'] = '/updates/android/../../secrets'
        with self.assertRaises(ValueError):
            release.publish(self.root, self.apk, manifest)

    def test_pointer_write_failure_keeps_previous_release(self):
        old = self.manifest()
        release.publish(self.root, self.apk, old)
        newer = self.manifest(3)
        with patch.object(release, 'atomic_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                release.publish(self.root, self.apk, newer)
        self.assertEqual(old, release.read_latest(self.root))


if __name__ == '__main__':
    unittest.main()
