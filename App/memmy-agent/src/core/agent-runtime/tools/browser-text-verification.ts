import type { ElementHandle } from 'playwright';

export type BrowserTextVerification = { status: 'matched' | 'normalized' | 'modified' | 'unavailable';
  reason?: 'maxlength' | 'page_changed_value' | 'target_replaced' | 'not_editable' };

/** Resolve label targeting once, before input, so later handlers cannot change the receiver. */
export async function bindBrowserTextInputReceiver(target: ElementHandle): Promise<ElementHandle> {
  const receiver = await target.evaluateHandle((node: any) => {
    if (!node.isConnected) return null;
    let element = node;
    if (!['INPUT', 'TEXTAREA'].includes(element.tagName) && !element.isContentEditable) {
      element = element.closest('label')?.control ?? element;
    }
    return element.isConnected && (['INPUT', 'TEXTAREA'].includes(element.tagName) || element.isContentEditable)
      ? element : null;
  });
  const field = receiver.asElement();
  if (field) return field;
  await receiver.dispose().catch(() => undefined);
  throw new Error('The input target is no longer editable; take a new snapshot before acting.');
}

/** Verify the original receiver without returning its value, including for password fields. */
export async function verifyBrowserTextInput(target: ElementHandle, expected: string): Promise<BrowserTextVerification> {
  return target.evaluate((element: any, requested: string) => {
    if (!element.isConnected) return { status: 'unavailable', reason: 'target_replaced' } as const;
    const native = ['INPUT', 'TEXTAREA'].includes(element.tagName);
    if (!native && !element.isContentEditable) return { status: 'unavailable', reason: 'not_editable' } as const;
    // An empty rich editor can retain a starter <p><br></p>, whose innerText is
    // a layout newline even though it has no text content.
    const actual = native ? String(element.value) : String(element.textContent ? element.innerText ?? element.textContent : '');
    if (actual === requested) return { status: 'matched' } as const;
    if (element.type === 'number') {
      // A page can format a number without changing it. Compare decimal digits
      // and powers exactly: Number() would hide rounding of high precision input.
      const decimal = (raw: string): string | null => {
        if (raw.length > 100_000) return null;
        const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
        if (!match || !((match[2] ?? '') + (match[3] ?? ''))) return null;
        const fraction = match[3] ?? '';
        const digits = ((match[2] ?? '') + fraction).replace(/^0+/, '');
        if (!digits) return '0';
        const coefficient = digits.replace(/0+$/, '');
        const exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length)
          + BigInt(digits.length - coefficient.length);
        return `${match[1] === '-' ? '-' : ''}${coefficient}e${exponent}`;
      };
      const expectedDecimal = decimal(requested);
      if (expectedDecimal !== null && decimal(actual) === expectedDecimal) {
        return { status: 'normalized' } as const;
      }
    }
    if ((element.tagName === 'TEXTAREA' || element.isContentEditable)
      && actual.replace(/\r\n?/g, '\n') === requested.replace(/\r\n?/g, '\n')) {
      return { status: 'normalized' } as const;
    }
    return { status: 'modified', reason: native && element.maxLength >= 0 && requested.length > element.maxLength
      && actual === requested.slice(0, element.maxLength) ? 'maxlength' : 'page_changed_value' } as const;
  }, expected);
}
