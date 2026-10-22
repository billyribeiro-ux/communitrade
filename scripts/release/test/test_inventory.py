import hashlib
import importlib.util
import io
import pathlib
import sqlite3
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('inventory', pathlib.Path(__file__).parents[1] / 'inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def read_header(self, header):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'fixture.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE Packages(blob BLOB)')
                db.execute('INSERT INTO Packages VALUES(?)', (header,))
            return inventory.rpm_packages(path)

    def header(self):
        data, entries = b'', b''
        for tag, value in [(1000, 'fixture-package'), (1001, '1.2.3'), (1002, '4.el9'), (1014, 'MIT'), (1022, 'x86_64')]:
            entries += struct.pack('>IIII', tag, 6, len(data), 1)
            data += value.encode() + b'\0'
        return struct.pack('>II', 5, len(data)) + entries + data

    def test_rpmdb_and_rpm_magic_preserve_identity_and_license(self):
        expected = [{'name': 'fixture-package', 'version': '1.2.3-4.el9', 'architecture': 'x86_64', 'license': 'MIT'}]
        self.assertEqual(self.read_header(self.header()), expected)
        self.assertEqual(self.read_header(b'\x8e\xad\xe8\x01\0\0\0\0' + self.header()), expected)

    def test_truncated_and_excessive_headers_fail(self):
        for header in [self.header()[:-1], struct.pack('>II', 20001, 0)]:
            with self.assertRaises(ValueError):
                self.read_header(header)

    def test_missing_package_identity_fails(self):
        with self.assertRaises(ValueError):
            self.read_header(struct.pack('>II', 0, 0))

    def test_notice_bytes_hash_and_safe_archive_path(self):
        buffer, records, data = io.BytesIO(), [], b'Fixture license\nCopyright example\n'
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            inventory.add_notice(archive, records, '../../LICENSE', data)
        with tarfile.open(fileobj=io.BytesIO(buffer.getvalue())) as archive:
            member = archive.getmembers()[0]
            self.assertEqual(member.name, 'LICENSE')
            self.assertEqual(archive.extractfile(member).read(), data)
        self.assertEqual(records[0]['sha256'], hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    unittest.main()
