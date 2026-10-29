import { describe, expect, it } from "vitest";
import {
  baseDirectoriesFromConfigText,
  configuredSearchRoots,
  dataRootsFromConfigText,
  discoverWeixinDatabaseRoot,
  findWeixinAccounts,
  normalizeWindowsPath,
  selectWeixinAccount,
  selectWeixinExecutable,
  WeixinDatabaseLookupError,
  type WindowsDirectoryReader,
} from "../../../../src/tools/computer-history/win/weixin-database.js";

function reader(tree: Record<string, { directories?: string[]; files?: string[] }>): WindowsDirectoryReader {
  return {
    directories(parent) {
      return tree[parent]?.directories ?? [];
    },
    files(parent) {
      return tree[parent]?.files ?? [];
    },
  };
}

const documents = String.raw`C:\Users\TestUser\Documents`;
const files = String.raw`C:\Users\TestUser\Documents\xwechat_files`;
const message = String.raw`C:\Users\TestUser\Documents\xwechat_files\wxid_example_aaaa\db_storage\message`;

describe("Weixin database location", () => {
  it("uses the running Weixin.exe and ignores the mini-program plugin", () => {
    const executable = selectWeixinExecutable([
      { name: "WeChatAppEx", executable: String.raw`C:\Users\TestUser\AppData\Roaming\Tencent\xwechat\xplugin\plugins\RadiumWMPF\WeChatAppEx.exe` },
      { name: "Weixin", executable: String.raw`C:\Program Files\Tencent\Weixin\Weixin.exe` },
    ], String.raw`D:\Other\Weixin`);
    expect(executable).toBe(String.raw`C:\Program Files\Tencent\Weixin\Weixin.exe`);
  });

  it("strips quotes from the uninstall location when Weixin is not running", () => {
    expect(normalizeWindowsPath('"C:\\Program Files\\Tencent\\Weixin"')).toBe(String.raw`C:\Program Files\Tencent\Weixin`);
    expect(selectWeixinExecutable([], '"C:\\Program Files\\Tencent\\Weixin"'))
      .toBe(String.raw`C:\Program Files\Tencent\Weixin\Weixin.exe`);
  });

  it("does not guess when two different Weixin.exe paths are running", () => {
    expect(selectWeixinExecutable([
      { name: "Weixin", executable: String.raw`C:\Program Files\Tencent\Weixin\Weixin.exe` },
      { name: "weixin", executable: String.raw`D:\Apps\Weixin\Weixin.exe` },
    ])).toBeNull();
  });

  it("selects the one wxid account message store and skips helper directories", () => {
    const accounts = findWeixinAccounts(reader({
      [files]: { directories: ["all_users", "Backup", "wxid_example_aaaa"] },
      [message]: { files: ["key_info.db", "message_0.db", "message_fts.db", "message_resource.db"] },
    }), { documentsDirectory: documents });
    expect(selectWeixinAccount(accounts)).toEqual({
      accountDirectoryName: "wxid_example_aaaa",
      databaseRoot: String.raw`C:\Users\TestUser\Documents\xwechat_files\wxid_example_aaaa\db_storage`,
    });
  });

  it("uses a configured xwechat_files directory instead of Documents", () => {
    const moved = String.raw`D:\Chat\xwechat_files`;
    const movedAccount = String.raw`D:\Chat\xwechat_files\wxid_example_bbbb`;
    const movedMessage = String.raw`D:\Chat\xwechat_files\wxid_example_bbbb\db_storage\message`;
    const accounts = findWeixinAccounts(reader({
      [String.raw`D:\Chat`]: { directories: ["xwechat_files"] },
      [moved]: { directories: ["wxid_example_bbbb"] },
      [movedMessage]: { files: ["message_0.db"] },
      [files]: { directories: ["wxid_example_aaaa"] },
      [message]: { files: ["message_0.db"] },
    }), {
      documentsDirectory: documents,
      configuredPaths: [String.raw`D:\Chat`],
    });
    expect(selectWeixinAccount(accounts).databaseRoot).toBe(winJoin(movedAccount));
  });

  it("reads a custom storage path out of Weixin config text", () => {
    expect(dataRootsFromConfigText('file_path="D:\\\\Chat\\\\xwechat_files"')).toEqual([
      String.raw`D:\Chat\xwechat_files`,
    ]);
    expect(dataRootsFromConfigText(String.raw`save=D:\Chat\xwechat_files`)).toEqual([
      String.raw`D:\Chat\xwechat_files`,
    ]);
  });

  it("extracts the parent folder Weixin 4 records instead of an xwechat_files path", () => {
    // The real config stores the base directory on its own line and a bare label elsewhere.
    expect(baseDirectoriesFromConfigText(documents)).toEqual([documents]);
    expect(baseDirectoriesFromConfigText("MyDocument:")).toEqual([]);
    expect(configuredSearchRoots(["MyDocument:", documents])).toEqual([documents]);
    expect(configuredSearchRoots([String.raw`D:\Chat\xwechat_files`])).toEqual([String.raw`D:\Chat\xwechat_files`]);
  });

  it("discovers the default Documents store from the real config layout", () => {
    const root = discoverWeixinDatabaseRoot(reader({
      [documents]: { directories: ["xwechat_files"] },
      [files]: { directories: ["all_users", "Backup", "wxid_example_aaaa"] },
      [message]: { files: ["key_info.db", "message_0.db", "message_fts.db"] },
    }), { documentsDirectory: documents, configTexts: ["MyDocument:", documents] });
    expect(root).toBe(String.raw`C:\Users\TestUser\Documents\xwechat_files\wxid_example_aaaa\db_storage`);
  });

  it("discovers a moved store on another drive while Documents stays empty", () => {
    const moved = String.raw`D:\WeixinData`;
    const movedFiles = String.raw`D:\WeixinData\xwechat_files`;
    const movedMessage = String.raw`D:\WeixinData\xwechat_files\wxid_example_bbbb\db_storage\message`;
    const root = discoverWeixinDatabaseRoot(reader({
      [moved]: { directories: ["xwechat_files"] },
      [movedFiles]: { directories: ["wxid_example_bbbb"] },
      [movedMessage]: { files: ["message_0.db"] },
    }), { documentsDirectory: documents, configTexts: [moved] });
    expect(root).toBe(String.raw`D:\WeixinData\xwechat_files\wxid_example_bbbb\db_storage`);
  });

  it("refuses to guess when no account or more than one account has message databases", () => {
    expect(() => selectWeixinAccount([])).toThrow(WeixinDatabaseLookupError);
    expect(() => selectWeixinAccount([])).toThrow("wechat_login_required");
    const accounts = findWeixinAccounts(reader({
      [files]: { directories: ["wxid_example_aaaa", "wxid_example_bbbb"] },
      [message]: { files: ["message_0.db"] },
      [String.raw`C:\Users\TestUser\Documents\xwechat_files\wxid_example_bbbb\db_storage\message`]: { files: ["message_1.db"] },
    }), { documentsDirectory: documents });
    expect(() => selectWeixinAccount(accounts)).toThrow("current_account_ambiguous");
  });
});

function winJoin(accountDirectory: string): string {
  return `${accountDirectory}\\db_storage`;
}
