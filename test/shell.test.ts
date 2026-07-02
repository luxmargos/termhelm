import { describe, expect, it } from 'vitest';
import { appleScriptString, buildPosixEnvPrefix, posixShellQuote, powershellQuote, windowsCmdQuote, windowsEchoEscape } from '../src/shell.js';

describe('shell helpers', () => {
  it('quotes POSIX shell values', () => {
    expect(posixShellQuote("a'b")).toBe("'a'\\''b'");
  });
  it('escapes AppleScript string literals', () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  it('builds POSIX env prefixes', () => {
    expect(buildPosixEnvPrefix({ A: 'one', B: "two's" })).toBe("A='one' B='two'\\''s' ");
  });
  it('quotes Windows values', () => {
    expect(windowsCmdQuote('a"b')).toBe('"a\\"b"');
    expect(windowsEchoEscape('a&b<c>d^e')).toBe('a^&b^<c^>d^^e');
    expect(powershellQuote("a'b")).toBe("'a''b'");
  });
});
