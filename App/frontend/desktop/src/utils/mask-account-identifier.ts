/** Mask account identifier module. */

/** Handles mask phone number. */
export function maskPhoneNumber(phone: string): string {
  const normalized = phone.trim();
  if (!normalized) {
    return "";
  }

  const digits = normalized.replace(/\D/g, "");
  if (digits.length >= 7) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  if (digits.length <= 2) {
    return "*".repeat(digits.length);
  }

  return `${digits.slice(0, 1)}${"*".repeat(digits.length - 2)}${digits.slice(-1)}`;
}

/**
 * Masks an email address.
 *
 * Keeps the first character and the domain after @, replacing the rest of the local part with ***.
 *
 * @param email The original email address.
 * @returns The masked email address.
 */
export function maskEmail(email: string): string {
  const normalized = email.trim();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (!domain) {
    return normalized;
  }

  const visibleLocal = localPart.slice(0, 1);
  return `${visibleLocal}***@${domain}`;
}

/**
 * Automatically masks an account identifier based on whether it is an email or a phone number.
 *
 * @param identifier An email address or phone number.
 * @returns The masked display text.
 */
export function maskAccountIdentifier(identifier: string): string {
  const normalized = identifier.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.includes("@")) {
    return maskEmail(normalized);
  }

  return maskPhoneNumber(normalized);
}
