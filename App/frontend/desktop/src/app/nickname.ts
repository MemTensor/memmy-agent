/** Nickname module. */
import { randomNickname, type NicknameLanguage } from "../lib/nickname.js";

/** Definition for local nickname storage key. */
const LOCAL_NICKNAME_STORAGE_KEY = "memmy.localNickname";

/** Contract for account nickname snapshot. */
export interface AccountNicknameSnapshot {
  email: string;
  phoneNumber: string | null;
  nickname: string;
  registeredAt: string | null;
}

/** Contract for nickname profile patch. */
export interface NicknameProfilePatch {
  email?: string | null;
  phoneNumber?: string | null;
  nickname?: string | null;
  registeredAt?: string | null;
}

/** Contract for account nickname update. */
export interface AccountNicknameUpdate {
  email: string;
  phoneNumber: string | null;
  nickname: string;
  registeredAt: string | null;
}

/** Reads read local nickname. */
export function readLocalNickname(storage: Storage | undefined): string | null {
  const value = storage?.getItem(LOCAL_NICKNAME_STORAGE_KEY);
  return value && value.trim() ? value : null;
}

/** Writes write local nickname. */
export function writeLocalNickname(storage: Storage | undefined, nickname: string): void {
  storage?.setItem(LOCAL_NICKNAME_STORAGE_KEY, nickname);
}

/** Handles resolve submitted nickname. */
export function resolveSubmittedNickname(raw: string, language: NicknameLanguage): string {
  return raw.trim() || randomNickname(language);
}

/** Builds build account nickname update. */
export function buildAccountNicknameUpdate(
  finalNickname: string,
  profile: NicknameProfilePatch | null | undefined,
  current: AccountNicknameSnapshot
): AccountNicknameUpdate {
  return {
    email: profile?.email ?? current.email,
    phoneNumber: profile?.phoneNumber ?? current.phoneNumber,
    nickname: profile?.nickname ?? finalNickname,
    registeredAt: profile?.registeredAt ?? current.registeredAt
  };
}

/** Handles persist nickname. */
export async function persistNickname(input: {
  rawNickname: string;
  language: NicknameLanguage;
  isByok: boolean;
  storage: Storage | undefined;
  current: AccountNicknameSnapshot;
  updateProfile: (nickname: string) => Promise<NicknameProfilePatch | null>;
}): Promise<AccountNicknameUpdate> {
  const finalNickname = resolveSubmittedNickname(input.rawNickname, input.language);

  if (input.isByok) {
    writeLocalNickname(input.storage, finalNickname);
    return buildAccountNicknameUpdate(finalNickname, null, input.current);
  }

  const profile = await input
    .updateProfile(finalNickname)
    .catch((error: unknown) => {
      console.warn("update account profile failed", error);
      return null;
    });
  return buildAccountNicknameUpdate(finalNickname, profile, input.current);
}
