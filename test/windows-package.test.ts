import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fallbackPath = 'native/windows/terminal-windows-controller.ps1';

describe('Windows controller package contents', () => {
  it('packages the PowerShell runtime fallback', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      files?: unknown[];
    };
    const files = (packageJson.files ?? []).map(value =>
      String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    );

    expect(existsSync(fallbackPath)).toBe(true);
    expect(files.some(entry => entry === 'native' || entry === 'native/windows')).toBe(true);
  });

  it('keeps official packaging strict about both native architectures', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const verifier = readFileSync('scripts/verify-windows-helpers.mjs', 'utf8');

    expect(packageJson.scripts?.prepack).toContain('verify:windows-helpers');
    expect(verifier).toContain("const supportedArchitectures = ['x64', 'arm64']");
    expect(verifier).toContain('Missing ${architecture} Windows controller helper');
    expect(verifier).toContain("const powerShellControllerRelativePath = 'native/windows/terminal-windows-controller.ps1'");
    expect(verifier).toContain('validatePowerShellController()');
    expect(verifier).toContain("'[string] $PayloadPath'");
    expect(verifier).toContain("'ConvertFrom-Json -ErrorAction Stop'");
    expect(verifier).toContain("'[IO.File]::Delete($payloadFullPath)'");
    expect(verifier).toContain("'$expectedSessionId = $payloadIdentity.Substring'");
    expect(verifier).toContain("'Controller payload identity does not match its filename.'");
    expect(verifier).toContain("'[StringComparison]::Ordinal'");
    expect(verifier).toContain("'$runEntered = $true'");
    expect(verifier).toContain(
      "'Write-PreLaunchFailureMarker $payload $payloadDirectory $expectedSessionId $expectedTargetId'"
    );
    expect(verifier).toContain("'[TerminalWindows.PowerShellController]::Run('");
    expect(verifier).toContain("'ExactSpelling = true'");
  });

  it('deletes the sensitive controller payload after successful or failed parsing', () => {
    const fallbackSource = readFileSync(fallbackPath, 'utf8');
    const readIndex = fallbackSource.indexOf('[IO.File]::ReadAllText($payloadFullPath');
    const parseIndex = fallbackSource.indexOf('ConvertFrom-Json -ErrorAction Stop', readIndex);
    const finallyIndex = fallbackSource.indexOf('} finally {', parseIndex);
    const deleteIndex = fallbackSource.indexOf('[IO.File]::Delete($payloadFullPath)', finallyIndex);
    const confirmIndex = fallbackSource.indexOf('[IO.File]::Exists($payloadFullPath)', deleteIndex);
    const postParseIndex = fallbackSource.indexOf(
      '# Parse and delete the secret-bearing payload before compiling.',
      finallyIndex
    );
    const environmentIndex = fallbackSource.indexOf('foreach ($entry in $payload.environment)', postParseIndex);
    const runIndex = fallbackSource.indexOf('[TerminalWindows.PowerShellController]::Run(', environmentIndex);

    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(parseIndex).toBeGreaterThan(readIndex);
    expect(finallyIndex).toBeGreaterThan(parseIndex);
    expect(deleteIndex).toBeGreaterThan(finallyIndex);
    expect(confirmIndex).toBeGreaterThan(deleteIndex);
    expect(postParseIndex).toBeGreaterThan(confirmIndex);
    expect(environmentIndex).toBeGreaterThan(postParseIndex);
    expect(runIndex).toBeGreaterThan(environmentIndex);
    expect(fallbackSource.slice(finallyIndex, postParseIndex)).toContain(
      "throw 'Controller payload deletion could not be confirmed.'"
    );
  });

  it('binds prelaunch failure identity to the controller payload filename', () => {
    const fallbackSource = readFileSync(fallbackPath, 'utf8');
    const windowsSource = readFileSync('src/platforms/windows.ts', 'utf8');
    const writerStart = fallbackSource.indexOf('function Write-PreLaunchFailureMarker');
    const writerEnd = fallbackSource.indexOf("$controllerSource = @'", writerStart);
    const writer = fallbackSource.slice(writerStart, writerEnd);
    const identityCheck = fallbackSource.indexOf(
      'Controller payload identity does not match its filename.'
    );
    const addType = fallbackSource.lastIndexOf(
      'Add-Type -TypeDefinition $controllerSource -Language CSharp -ErrorAction Stop'
    );

    expect(windowsSource).toContain('`${control.sessionId}.${control.id}.controller.json`');
    expect(writer).toContain('$ExpectedSessionId');
    expect(writer).toContain('$ExpectedTargetId');
    expect(writer).toContain('[StringComparison]::Ordinal');
    expect(writer).not.toContain('$Payload.sessionId');
    expect(writer).not.toContain('$Payload.targetId');
    expect(identityCheck).toBeGreaterThan(writerEnd);
    expect(addType).toBeGreaterThan(identityCheck);
  });
});
