import { expect, it } from 'vitest';
import { verifyWindowsComputerUseRuntime } from '../scripts/internal/win/verify-computer-use-runtime.mjs';
import { windowsPEFixture } from './fixtures/windows-pe-fixture.mjs';

it('accepts the target PE architecture and the exact embedded PowerShell bytes', () => {
  const source = Buffer.from('# runtime fixture\r\nparam($Request)\r\n');
  expect(() => verifyWindowsComputerUseRuntime(windowsPEFixture(0x8664, source), 'x64', source)).not.toThrow();
  expect(() => verifyWindowsComputerUseRuntime(windowsPEFixture(0xaa64, source), 'arm64', source)).not.toThrow();
});

it('rejects foreign CPU, DLL, truncated, and invalid PE offset helpers', () => {
  expect(() => verifyWindowsComputerUseRuntime(windowsPEFixture(0xaa64), 'x64')).toThrow(/x64 PE32\+/);
  const dll = windowsPEFixture(); dll.writeUInt16LE(0x2022, 0x96);
  expect(() => verifyWindowsComputerUseRuntime(dll)).toThrow(/PE32\+ executable/);
  expect(() => verifyWindowsComputerUseRuntime(Buffer.from('MZ'))).toThrow(/PE executable/);
  const badOffset = windowsPEFixture(); badOffset.writeUInt32LE(0xfffffff0, 0x3c);
  expect(() => verifyWindowsComputerUseRuntime(badOffset)).toThrow(/PE32\+ executable/);
});

it('rejects a helper compiled before the current PowerShell runtime change', () => {
  const oldSource = Buffer.from('# old runtime\n');
  const source = Buffer.from('# current runtime\n');
  expect(() => verifyWindowsComputerUseRuntime(windowsPEFixture(0x8664, oldSource), 'x64', source))
    .toThrow(/does not embed the current runtime.ps1/);
  expect(() => verifyWindowsComputerUseRuntime(windowsPEFixture(), 'x64', Buffer.alloc(0)))
    .toThrow(/does not embed/);
});
