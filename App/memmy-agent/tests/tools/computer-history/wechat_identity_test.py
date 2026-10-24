import hashlib
import importlib.util
import unittest
from pathlib import Path


path = Path(__file__).resolve().parents[3] / "src/tools/computer-history/wechat_identity.py"
spec = importlib.util.spec_from_file_location("wechat_identity", path)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class WeChatIdentity(unittest.TestCase):
    def test_signed_in_account_is_the_directory_wxid_without_the_local_suffix(self):
        self.assertEqual(identity.self_username("wxid_00vo7lzs1kpn12_93ba"), "wxid_00vo7lzs1kpn12")
        self.assertEqual(identity.self_username("wxid_plain"), "wxid_plain")

    def test_private_group_and_file_transfer_are_different_chats(self):
        self.assertEqual(identity.chat_kind("wxid_friend"), "private")
        self.assertEqual(identity.chat_kind("123@chatroom"), "group")
        self.assertEqual(identity.chat_kind("filehelper"), "file_transfer")

    def test_message_table_names_the_chat_and_self_is_not_just_an_id(self):
        friend = "wxid_wu9pa30i6ohf12"
        me = "wxid_00vo7lzs1kpn12"
        group = "10001@chatroom"
        profiles = {
            friend: {"remark": "小王", "nick": "王先生"},
            group: {"remark": "", "nick": "家庭群"},
        }
        table = "Msg_" + hashlib.md5(friend.encode()).hexdigest()
        sent = identity.describe_message(table, me, me, profiles, [friend, me, group])
        received = identity.describe_message(table, friend, me, profiles, [friend, me, group])
        self.assertEqual(sent, {
            "chatKind": "private", "chatName": "小王", "senderName": "自己", "fromSelf": True,
        })
        self.assertEqual(received["senderName"], "小王")
        self.assertFalse(received["fromSelf"])
        group_table = "Msg_" + hashlib.md5(group.encode()).hexdigest()
        group_message = identity.describe_message(group_table, friend, me, profiles, [group, friend])
        self.assertEqual(group_message["chatKind"], "group")
        self.assertEqual(group_message["chatName"], "家庭群")


if __name__ == "__main__":
    unittest.main()
