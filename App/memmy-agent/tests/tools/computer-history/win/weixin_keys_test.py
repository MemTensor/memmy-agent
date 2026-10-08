import hashlib
import hmac
import importlib.util
import struct
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[4] / "src/tools/computer-history/win/weixin_keys.py"
spec = importlib.util.spec_from_file_location("weixin_keys", MODULE_PATH)
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)


def page_for(raw_key, salt=None):
    salt = salt or bytes(range(16))
    body = bytes((index * 3) % 256 for index in range(4016))
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", raw_key, mac_salt, 2, 32)
    digest = hmac.new(mac_key, body + b"\x01\x00\x00\x00", hashlib.sha512).digest()
    return salt + body + digest


class MapMemory(keys.ProcessMemory):
    def __init__(self, base, data):
        self.base = base
        self.data = data

    def regions(self):
        return [(self.base, len(self.data))]

    def read(self, address, size):
        start = address - self.base
        if start < 0 or start + size > len(self.data):
            return b""
        return self.data[start:start + size]


def cipher_image(raw_key, salt):
    literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
    blob = keys.xor_repeat(literal, keys.CIPHER_MASK)
    assert len(blob) == 99
    base = 0x200000
    size = 0x1000
    data = bytearray(size)
    needle = 0x100
    data[needle:needle + len(keys.CIPHER_NAME)] = keys.CIPHER_NAME
    pair = 0x220
    node = pair - 0x10
    struct.pack_into("<Q", data, node + 0x10, base + needle)
    struct.pack_into("<Q", data, node + 0x18, len(keys.CIPHER_NAME))
    config_ptr = base + 0x400
    struct.pack_into("<Q", data, node + 0x28, config_ptr)
    data_ptr = base + 0x800
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x8, data_ptr)
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x10, 99)
    data[0x800:0x800 + 99] = blob
    return MapMemory(base, bytes(data))


class WeixinKeyCheck(unittest.TestCase):
    def test_page_check_accepts_only_the_real_key(self):
        raw_key = bytes(range(32))
        page = page_for(raw_key)
        self.assertTrue(keys.authenticated_page(raw_key, page))
        self.assertFalse(keys.authenticated_page(bytes(range(1, 33)), page))

    def test_config_cipher_scan_keeps_a_key_only_after_the_page_matches(self):
        raw_key = bytes((index * 7 + 3) % 256 for index in range(32))
        salt = bytes(range(16, 32))
        page = page_for(raw_key, salt)
        found, stats = keys.scan_config_cipher(
            cipher_image(raw_key, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {"message/message_0.db": raw_key.hex()})
        self.assertEqual(stats["cipher_string_hits"], 1)
        self.assertGreaterEqual(stats["candidates"], 1)

        wrong = bytes((index * 7 + 4) % 256 for index in range(32))
        found, _stats = keys.scan_config_cipher(
            cipher_image(wrong, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {})

    def test_raw_literal_scan_matches_salt_and_page(self):
        raw_key = bytes((index * 5 + 1) % 256 for index in range(32))
        salt = bytes(range(8, 24))
        page = page_for(raw_key, salt)
        literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
        memory = MapMemory(0x300000, literal + b"\x00" * 16)
        self.assertEqual(
            keys.scan_raw_literals(memory, {"message/message_0.db": page}),
            {"message/message_0.db": raw_key.hex()},
        )

    def test_decrypt_page_restores_the_sqlite_header(self):
        def identity(_key, _iv, data):
            return data

        page = b"\x22" * 4096
        restored = keys.decrypt_page(b"k" * 32, page, 1, identity)
        self.assertEqual(len(restored), 4096)
        self.assertTrue(restored.startswith(b"SQLite format 3\x00"))
        self.assertEqual(
            keys.aes_cbc_decrypt(
                bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4"),
                bytes.fromhex("000102030405060708090a0b0c0d0e0f"),
                bytes.fromhex("f58c4c04d6e5f1ba779eabfb5f7bfbd6"),
            ),
            bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"),
        )
        self.assertEqual(keys.decode_text(1, "你好".encode()), "你好")
        self.assertIsNone(keys.decode_text(3, b"image"))
        self.assertEqual(keys.message_kind(25769803825), 49)
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "小王", "nick": "王先生"}}), "小王(备注)")
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "", "nick": "王先生"}}), "王先生(昵称)")
        self.assertEqual(keys.labeled_name("wxid_friend", {}), "wxid_friend(无备注无昵称)")
        self.assertEqual(keys.labeled_name("wxid_me", {}, "wxid_me"), "自己")
        self.assertEqual(
            keys.message_preview(25769803825, "<msg><appmsg><title><![CDATA[note.txt]]></title></appmsg></msg>".encode()),
            "file=note.txt",
        )


if __name__ == "__main__":
    unittest.main()
