"""Turn WeChat ids into the chat and person a user would recognize.

A message table is named Msg_ plus the MD5 of the chat username. A normal
username is a private chat, and a username ending in @chatroom is a group.
The signed-in account is the wxid in the data directory. Display names prefer
the user's own remark, then the nickname.
"""

import hashlib
import re


def self_username(account_directory_name):
    """wxid_xxx_ab12 directories store the account id before the local suffix."""
    match = re.fullmatch(r"(wxid_[0-9A-Za-z]+)_[0-9a-fA-F]{4}", account_directory_name or "")
    if match:
        return match.group(1)
    if (account_directory_name or "").startswith("wxid_"):
        return account_directory_name
    return None


def chat_kind(username):
    if not username:
        return "unknown"
    if username.endswith("@chatroom"):
        return "group"
    if username == "filehelper":
        return "file_transfer"
    return "private"


def username_by_message_table(usernames):
    return {hashlib.md5(name.encode("utf-8")).hexdigest(): name for name in usernames if name}


def display_name(username, profiles, self_id=None):
    if not username:
        return None
    if self_id and username == self_id:
        return "自己"
    profile = profiles.get(username) or {}
    remark = (profile.get("remark") or "").strip()
    nick = (profile.get("nick") or "").strip()
    if remark:
        return remark
    if nick:
        return nick
    if username == "filehelper":
        return "文件传输助手"
    return username


def describe_message(table, sender_id, self_id, profiles, usernames):
    chat_username = username_by_message_table(usernames).get(table[4:] if table.startswith("Msg_") else "")
    known_self = bool(sender_id and self_id)
    return {
        "chatKind": chat_kind(chat_username),
        "chatName": display_name(chat_username, profiles),
        "senderName": display_name(sender_id, profiles, self_id),
        "fromSelf": sender_id == self_id if known_self else None,
    }
