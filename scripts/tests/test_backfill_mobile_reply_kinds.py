import importlib.machinery
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'backfill-mobile-reply-kinds'
loader = importlib.machinery.SourceFileLoader('reply_kind_backfill', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class ReplyKindBackfillTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        with sqlite3.connect(self.root / 'orchestrator.sqlite') as source:
            source.execute('CREATE TABLE outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
            source.executemany('INSERT INTO outbox VALUES (?,?)', [(key, json.dumps({'kind': kind})) for key, kind in [
                ('ack-1', 'acknowledgement'), ('reply-1', 'reply'), ('notice-1', 'notice'), ('bad-1', 'made-up'), ('pinned', 'reply')]])
        with sqlite3.connect(self.root / 'mobileq.db') as queue:
            queue.execute('CREATE TABLE replies(id INTEGER PRIMARY KEY,rkey TEXT UNIQUE,text TEXT,at TEXT,bot_id TEXT,kind TEXT)')
            queue.executemany('INSERT INTO replies VALUES (?,?,?,?,?,?)', [
                (1, 'ack-1', '接手了\n正文保持', '2026-11-17T00:00:00Z', 'lead', None),
                (2, 'reply-1', '答复', '2026-11-17T00:00:01Z', 'lead', None),
                (3, 'notice-1', 'notice', '2026-11-17T00:00:02Z', None, None),
                (4, 'bad-1', 'unknown receipt kind', '', None, None),
                (5, 'no-matching-id', '接手了', '', None, None),
                (6, 'pinned', 'already typed', '', 'lead', 'notice')])

    def kinds(self):
        with sqlite3.connect(self.root / 'mobileq.db') as queue:
            return queue.execute('SELECT kind FROM replies ORDER BY id').fetchall()

    def test_dry_run_uses_exact_receipt_ids_without_mutation(self):
        before = self.kinds()
        result = module.backfill(self.root)
        self.assertEqual(result['matched'], 3)
        self.assertEqual(result['remainingLegacy'], 2)
        self.assertEqual(self.kinds(), before)
        self.assertFalse(result['applied'])

    def test_apply_preserves_content_and_existing_types_is_idempotent(self):
        result = module.backfill(self.root, True)
        self.assertTrue(result['contentPreserved'])
        self.assertEqual(self.kinds(), [('acknowledgement',), ('reply',), ('notice',), (None,), (None,), ('notice',)])
        self.assertEqual(module.backfill(self.root, True)['matched'], 0)
        with sqlite3.connect(self.root / 'mobileq.db') as queue:
            self.assertEqual(queue.execute('SELECT text,bot_id FROM replies WHERE id=1').fetchone(), ('接手了\n正文保持', 'lead'))

    def test_missing_column_fails_without_schema_or_content_write(self):
        with sqlite3.connect(self.root / 'mobileq.db') as queue:
            queue.execute('ALTER TABLE replies DROP COLUMN kind')
        before = (self.root / 'mobileq.db').read_bytes()
        with self.assertRaisesRegex(ValueError, 'kind is missing'):
            module.backfill(self.root, True)
        self.assertEqual((self.root / 'mobileq.db').read_bytes(), before)

    def test_malformed_receipt_aborts_before_opening_queue_for_write(self):
        with sqlite3.connect(self.root / 'orchestrator.sqlite') as source:
            source.execute("INSERT INTO outbox VALUES ('corrupt','{')")
        before = (self.root / 'mobileq.db').read_bytes()
        with self.assertRaises(sqlite3.DatabaseError):
            module.backfill(self.root, True)
        self.assertEqual((self.root / 'mobileq.db').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
