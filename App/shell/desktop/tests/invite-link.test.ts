import { describe, expect, it } from 'vitest';
import { findInviteLink, parseInviteLink } from '../src/main/invite-link.js';

const CODE = 'Ab3dEf6hIj9kLm2nOp5qRs8t';

describe('parseInviteLink', () => {
  it.each([
    `memmy://invite/${CODE}`,
    `memmy:///invite/${CODE}`,
    `MEMMY://INVITE/${CODE}`,
    `memmy://invite/${CODE}/`,
    `  memmy://invite/${CODE}  `,
  ])('reads the code out of %s', (link) => {
    expect(parseInviteLink(link)).toBe(CODE);
  });

  it.each([
    ['a plain invite code', CODE],
    ['another scheme', `https://memmy.example/api/i/${CODE}`],
    ['the app origin used for analytics', 'memmy://prod.app/main'],
    ['a path without a code', 'memmy://invite/'],
    ['a code of the wrong shape', 'memmy://invite/short'],
    ['extra path segments', `memmy://invite/${CODE}/more`],
    ['a query string on the code', `memmy://invite/${CODE}?x=1`],
    ['a non-string argument', 42],
    ['nothing', null],
  ])('ignores %s', (_label, value) => {
    expect(parseInviteLink(value)).toBeNull();
  });
});

describe('findInviteLink', () => {
  it('finds the link among the arguments Windows passes to the second instance', () => {
    expect(findInviteLink(['/Applications/Memmy.app/Contents/MacOS/Memmy', `memmy://invite/${CODE}`])).toBe(CODE);
  });

  it('finds nothing in an ordinary command line', () => {
    expect(findInviteLink(['/Applications/Memmy.app/Contents/MacOS/Memmy', '--memmy-permission-relaunch'])).toBeNull();
    expect(findInviteLink(undefined)).toBeNull();
  });
});
