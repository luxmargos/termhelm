[CmdletBinding()]
param(
  [switch] $SelfTest,
  [string] $PayloadPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-PreLaunchFailureMarker {
  param(
    [object] $Payload,
    [string] $ControlDirectory,
    [string] $ExpectedSessionId,
    [string] $ExpectedTargetId
  )

  $temporaryPath = $null
  try {
    if ($null -eq $Payload -or [string]::IsNullOrWhiteSpace($ControlDirectory)) {
      return
    }
    $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    if ($ExpectedSessionId -notmatch $uuidPattern -or $ExpectedTargetId -notmatch $uuidPattern) {
      return
    }

    $canonicalDirectory = [IO.Path]::GetFullPath($ControlDirectory)
    $failedPath = [IO.Path]::GetFullPath([string] $Payload.failedFile)
    $failedName = [IO.Path]::GetFileName($failedPath)
    $managedFailedName = $ExpectedTargetId + '.failed.json'
    if (-not [String]::Equals(
        [IO.Path]::GetDirectoryName($failedPath),
        $canonicalDirectory,
        [StringComparison]::Ordinal
      ) -or (
        -not [String]::Equals($failedName, 'failed', [StringComparison]::Ordinal) -and
        -not [String]::Equals($failedName, $managedFailedName, [StringComparison]::Ordinal)
      ) -or -not [IO.Directory]::Exists($canonicalDirectory)) {
      return
    }

    $updatedAt = [DateTime]::UtcNow.ToString(
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [Globalization.CultureInfo]::InvariantCulture
    )
    $json = '{"version":2,"sessionId":"' + $ExpectedSessionId +
      '","targetId":"' + $ExpectedTargetId +
      '","state":"failed","updatedAt":"' + $updatedAt + '"}' + "`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $temporaryPath = $failedPath + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $file = [IO.File]::Open(
      $temporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $file.Write($bytes, 0, $bytes.Length)
      $file.Flush($true)
    } finally {
      $file.Dispose()
    }

    try {
      [IO.File]::Move($temporaryPath, $failedPath)
      $temporaryPath = $null
    } catch [IO.IOException] {
      if (-not [IO.File]::Exists($failedPath)) {
        throw
      }
    }
  } catch {
    # Preserve the original bootstrap failure and remain fail-closed if this
    # recovery marker cannot be published.
  } finally {
    if ($null -ne $temporaryPath) {
      try { [IO.File]::Delete($temporaryPath) } catch { }
    }
  }
}

$controllerSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace TerminalWindows
{
    public static class PowerShellController
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NEW_CONSOLE = 0x00000010;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint STARTF_USESHOWWINDOW = 0x00000001;
        private const short SW_HIDE = 0;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint WAIT_FAILED = 0xffffffff;
        private const uint CTRL_BREAK_EVENT = 1;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
        private static readonly Regex UuidPattern = new Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
            RegexOptions.CultureInvariant);
        private static readonly Regex TokenPattern = new Regex(
            "^[A-Za-z0-9_-]{32,256}$",
            RegexOptions.CultureInvariant);
        private static readonly ConsoleControlHandler IgnoreControlHandler =
            delegate(uint controlType) { return true; };

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private delegate bool ConsoleControlHandler(uint controlType);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            int informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            int informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachConsole(uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetConsoleCtrlHandler(
            ConsoleControlHandler handler,
            [MarshalAs(UnmanagedType.Bool)] bool add);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekNamedPipe(
            IntPtr pipe,
            IntPtr buffer,
            uint bufferSize,
            IntPtr bytesRead,
            out uint totalBytesAvailable,
            IntPtr bytesLeftThisMessage);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileEx(string existingPath, string newPath, uint flags);

        [DllImport(
            "kernel32.dll",
            EntryPoint = "SetEnvironmentVariableW",
            SetLastError = true,
            CharSet = CharSet.Unicode,
            ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetEnvironmentVariableNative(
            string name,
            string value);

        private sealed class ControllerWatch : IDisposable
        {
            private NamedPipeClientStream stream;
            private StreamReader reader;
            private StreamWriter writer;

            private ControllerWatch(
                NamedPipeClientStream connectedStream,
                StreamReader connectedReader,
                StreamWriter connectedWriter)
            {
                stream = connectedStream;
                reader = connectedReader;
                writer = connectedWriter;
            }

            public static ControllerWatch Connect(
                string endpoint,
                string token,
                string sessionId,
                string targetId)
            {
                if (String.IsNullOrEmpty(endpoint) && String.IsNullOrEmpty(token))
                {
                    return null;
                }
                if (String.IsNullOrEmpty(endpoint) || String.IsNullOrEmpty(token))
                {
                    throw new InvalidOperationException(
                        "Controller endpoint and authentication token must be provided together.");
                }
                if (!TokenPattern.IsMatch(token))
                {
                    throw new InvalidOperationException(
                        "Controller authentication token is invalid.");
                }

                const string prefix = @"\\.\pipe\";
                if (!endpoint.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                    endpoint.Length == prefix.Length)
                {
                    throw new InvalidOperationException(
                        "Managed controller named-pipe endpoint is invalid.");
                }

                NamedPipeClientStream pipe = null;
                StreamReader pipeReader = null;
                StreamWriter pipeWriter = null;
                try
                {
                    pipe = new NamedPipeClientStream(
                        ".",
                        endpoint.Substring(prefix.Length),
                        PipeDirection.InOut,
                        PipeOptions.Asynchronous);
                    pipe.Connect(5000);
                    UTF8Encoding encoding = new UTF8Encoding(false);
                    pipeReader = new StreamReader(pipe, encoding, false, 1024, true);
                    pipeWriter = new StreamWriter(pipe, encoding, 1024, true);
                    pipeWriter.NewLine = "\n";
                    pipeWriter.AutoFlush = true;

                    string target = targetId.ToLowerInvariant();
                    string request =
                        "{\"type\":\"watch\",\"authenticationToken\":\"" + token +
                        "\",\"requestId\":\"" + target +
                        "\",\"sessionId\":\"" + sessionId.ToLowerInvariant() +
                        "\",\"targetId\":\"" + target + "\"}";
                    pipeWriter.WriteLine(request);

                    Task<string> acknowledgementTask = pipeReader.ReadLineAsync();
                    if (!acknowledgementTask.Wait(5000))
                    {
                        throw new TimeoutException(
                            "Timed out reading the managed controller watch acknowledgement.");
                    }
                    string acknowledgement = acknowledgementTask.Result;
                    string expected =
                        "{\"type\":\"watching\",\"requestId\":\"" + target + "\"}";
                    if (!String.Equals(acknowledgement, expected, StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            "Managed controller watch authentication failed.");
                    }
                    return new ControllerWatch(pipe, pipeReader, pipeWriter);
                }
                catch
                {
                    if (pipeWriter != null) pipeWriter.Dispose();
                    if (pipeReader != null) pipeReader.Dispose();
                    if (pipe != null) pipe.Dispose();
                    throw;
                }
            }

            public bool IsDisconnected()
            {
                if (stream == null || !stream.IsConnected)
                {
                    return true;
                }
                uint available;
                return !PeekNamedPipe(
                    stream.SafePipeHandle.DangerousGetHandle(),
                    IntPtr.Zero,
                    0,
                    IntPtr.Zero,
                    out available,
                    IntPtr.Zero);
            }

            public void SendState(string state)
            {
                if (writer == null)
                {
                    return;
                }
                writer.WriteLine(
                    "{\"type\":\"state\",\"state\":\"" + state + "\"}");
            }

            public void TrySendState(string state)
            {
                try
                {
                    SendState(state);
                }
                catch
                {
                    // Atomic recovery markers remain authoritative.
                }
            }

            public void Dispose()
            {
                try
                {
                    if (writer != null)
                    {
                        writer.Dispose();
                    }
                }
                finally
                {
                    writer = null;
                    try
                    {
                        if (reader != null)
                        {
                            reader.Dispose();
                        }
                    }
                    finally
                    {
                        reader = null;
                        if (stream != null)
                        {
                            stream.Dispose();
                        }
                        stream = null;
                    }
                }
            }
        }

        private static void ThrowLastError(string operation)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        private static void TryReportError(Exception error)
        {
            try
            {
                Console.Error.WriteLine(error.Message);
            }
            catch
            {
                // Attaching to the managed console can invalidate inherited
                // standard handles. Recovery markers carry lifecycle truth.
            }
        }

        private static string Required(string value, string description)
        {
            if (String.IsNullOrEmpty(value))
            {
                throw new InvalidOperationException(
                    "Missing required controller " + description + ".");
            }
            return value;
        }

        private static string RequiredUuid(string value, string description)
        {
            string required = Required(value, description);
            if (!UuidPattern.IsMatch(required))
            {
                throw new InvalidOperationException("Invalid controller UUID.");
            }
            return required.ToLowerInvariant();
        }

        public static void SetProcessEnvironmentVariable(string name, string value)
        {
            name = Required(name, "environment variable name");
            if (name.IndexOf('=') >= 0)
            {
                throw new InvalidOperationException(
                    "Controller environment variable names cannot contain an equals sign.");
            }
            if (value == null)
            {
                value = String.Empty;
            }
            if (!SetEnvironmentVariableNative(name, value))
            {
                ThrowLastError("Setting a controller environment variable failed");
            }
        }

        private static string QuoteCreateProcessArgument(string value)
        {
            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static void ConfigureKillOnClose(IntPtr job)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                ThrowLastError("SetInformationJobObject failed");
            }
        }

        private static bool IsJobEmpty(IntPtr job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    out accounting,
                    Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                    IntPtr.Zero))
            {
                ThrowLastError("QueryInformationJobObject failed");
            }
            return accounting.ActiveProcesses == 0;
        }

        private static bool IsJobPossiblyActive(IntPtr job)
        {
            try
            {
                return !IsJobEmpty(job);
            }
            catch
            {
                return true;
            }
        }

        private static bool WaitForJobEmpty(IntPtr job, uint timeoutMs)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            if (IsJobEmpty(job))
            {
                return true;
            }
            for (;;)
            {
                long remaining = (long)timeoutMs - stopwatch.ElapsedMilliseconds;
                if (remaining <= 0)
                {
                    break;
                }
                Thread.Sleep((int)Math.Min(50L, remaining));
                if (IsJobEmpty(job))
                {
                    return true;
                }
            }
            return IsJobEmpty(job);
        }

        private static void AttachManagedConsole(uint processId)
        {
            FreeConsole();
            if (!AttachConsole(processId))
            {
                ThrowLastError("AttachConsole failed");
            }
            if (!SetConsoleCtrlHandler(IgnoreControlHandler, true))
            {
                ThrowLastError("SetConsoleCtrlHandler failed");
            }
        }

        private static void TrySendCtrlBreak()
        {
            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
            Thread.Sleep(50);
        }

        private static bool SupervisorExited(IntPtr supervisor)
        {
            uint result = WaitForSingleObject(supervisor, 0);
            if (result == WAIT_OBJECT_0)
            {
                return true;
            }
            if (result == WAIT_TIMEOUT)
            {
                return false;
            }
            ThrowLastError("Waiting for the supervisor process failed");
            return false;
        }

        private static string MarkerTimestamp()
        {
            return DateTime.UtcNow.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture);
        }

        private static void WriteStateMarker(
            string path,
            string sessionId,
            string targetId,
            string state)
        {
            if (String.IsNullOrEmpty(path) ||
                String.IsNullOrEmpty(sessionId) ||
                String.IsNullOrEmpty(targetId))
            {
                throw new InvalidOperationException(
                    "Marker path and identity are required.");
            }
            string parent = Path.GetDirectoryName(path);
            if (String.IsNullOrEmpty(parent))
            {
                throw new InvalidOperationException(
                    "Marker path must include a parent directory.");
            }
            Directory.CreateDirectory(parent);
            string json =
                "{\"version\":2,\"sessionId\":\"" + sessionId +
                "\",\"targetId\":\"" + targetId +
                "\",\"state\":\"" + state +
                "\",\"updatedAt\":\"" + MarkerTimestamp() + "\"}\n";
            byte[] bytes = new UTF8Encoding(false).GetBytes(json);

            string temporaryPath = null;
            for (int attempt = 0; attempt < 256; attempt++)
            {
                string candidate =
                    path + "." +
                    System.Diagnostics.Process.GetCurrentProcess().Id.ToString(
                        CultureInfo.InvariantCulture) + "." +
                    DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture) + "." +
                    attempt.ToString(CultureInfo.InvariantCulture) + ".tmp";
                bool candidateCreated = false;
                try
                {
                    using (FileStream file = new FileStream(
                        candidate,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        4096,
                        FileOptions.WriteThrough))
                    {
                        candidateCreated = true;
                        file.Write(bytes, 0, bytes.Length);
                        file.Flush(true);
                    }
                    temporaryPath = candidate;
                    break;
                }
                catch (IOException)
                {
                    if (candidateCreated)
                    {
                        try { File.Delete(candidate); } catch { }
                        throw;
                    }
                    // Retry only when CreateNew found an existing candidate.
                    if (!File.Exists(candidate))
                    {
                        throw;
                    }
                }
            }
            if (temporaryPath == null)
            {
                throw new IOException("Unable to allocate a temporary marker file.");
            }

            try
            {
                if (!MoveFileEx(
                        temporaryPath,
                        path,
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                {
                    ThrowLastError("Publishing marker failed");
                }
                temporaryPath = null;
            }
            finally
            {
                if (temporaryPath != null)
                {
                    try { File.Delete(temporaryPath); } catch { }
                }
            }
        }

        private static void TryWriteStateMarker(
            string path,
            string sessionId,
            string targetId,
            string state)
        {
            try
            {
                if (!String.IsNullOrEmpty(path) &&
                    !String.IsNullOrEmpty(sessionId) &&
                    !String.IsNullOrEmpty(targetId))
                {
                    WriteStateMarker(path, sessionId, targetId, state);
                }
            }
            catch
            {
                // The owner may already have removed its private state directory.
            }
        }

        private static void Close(ref IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }

        public static int SelfTest()
        {
            IntPtr job = IntPtr.Zero;
            IntPtr childProcess = IntPtr.Zero;
            IntPtr childThread = IntPtr.Zero;
            bool childCreated = false;
            bool childAssigned = false;

            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    ThrowLastError("Self-test CreateJobObject failed");
                }
                ConfigureKillOnClose(job);

                string comspec = Environment.GetEnvironmentVariable("ComSpec");
                if (String.IsNullOrEmpty(comspec))
                {
                    comspec = "cmd.exe";
                }

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESHOWWINDOW;
                startup.wShowWindow = SW_HIDE;
                PROCESS_INFORMATION child;
                StringBuilder commandLine = new StringBuilder(
                    QuoteCreateProcessArgument(comspec) +
                    " /d /q /c exit /b 0");
                uint flags =
                    CREATE_SUSPENDED |
                    CREATE_NEW_CONSOLE |
                    CREATE_UNICODE_ENVIRONMENT;
                if (!CreateProcess(
                        comspec,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        false,
                        flags,
                        IntPtr.Zero,
                        null,
                        ref startup,
                        out child))
                {
                    ThrowLastError("Self-test CreateProcess failed");
                }
                childCreated = true;
                childProcess = child.hProcess;
                childThread = child.hThread;

                if (!AssignProcessToJobObject(job, childProcess))
                {
                    ThrowLastError("Self-test AssignProcessToJobObject failed");
                }
                childAssigned = true;
                AttachManagedConsole(child.dwProcessId);
                if (ResumeThread(childThread) == UInt32.MaxValue)
                {
                    ThrowLastError("Self-test ResumeThread failed");
                }
                Close(ref childThread);

                uint processWait = WaitForSingleObject(childProcess, 5000);
                if (processWait == WAIT_FAILED)
                {
                    ThrowLastError("Self-test child wait failed");
                }
                if (processWait != WAIT_OBJECT_0)
                {
                    if (!TerminateJobObject(job, 1))
                    {
                        ThrowLastError(
                            "Self-test timed out and could not terminate its Job Object");
                    }
                    if (!WaitForJobEmpty(job, 5000))
                    {
                        throw new InvalidOperationException(
                            "Self-test timed out and its Job Object remained active.");
                    }
                    throw new TimeoutException(
                        "Self-test command did not exit within its deadline.");
                }

                uint exitCode;
                if (!GetExitCodeProcess(childProcess, out exitCode))
                {
                    ThrowLastError(
                        "Self-test could not read its child exit code");
                }
                if (exitCode != 0)
                {
                    throw new InvalidOperationException(
                        "Self-test command returned a non-zero exit code.");
                }
                if (!WaitForJobEmpty(job, 5000))
                {
                    throw new InvalidOperationException(
                        "Self-test Job Object did not become empty.");
                }
                return 0;
            }
            catch (Exception error)
            {
                if (childCreated && !childAssigned && childProcess != IntPtr.Zero)
                {
                    if (!TerminateProcess(childProcess, 1) &&
                        childThread != IntPtr.Zero)
                    {
                        // The self-test payload is only `exit 0`; allow that
                        // harmless suspended payload to finish rather than
                        // stranding it if termination is denied by policy.
                        ResumeThread(childThread);
                    }
                    WaitForSingleObject(childProcess, 5000);
                }
                if (childAssigned && job != IntPtr.Zero &&
                    IsJobPossiblyActive(job))
                {
                    TerminateJobObject(job, 1);
                    try { WaitForJobEmpty(job, 5000); } catch { }
                }
                TryReportError(error);
                return 1;
            }
            finally
            {
                Close(ref childThread);
                Close(ref childProcess);
                Close(ref job);
            }
        }

        public static int Run(
            string commandFile,
            string comspec,
            string workingDirectory,
            string title,
            string sessionId,
            string targetId,
            string targetToken,
            string readyFile,
            string stoppingFile,
            string stoppedFile,
            string failedFile,
            string forcedFile,
            uint graceMs,
            uint forceWaitMs,
            uint supervisorPid,
            string shutdownToken,
            string controlEndpoint,
            string controlToken)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr supervisor = IntPtr.Zero;
            IntPtr childProcess = IntPtr.Zero;
            IntPtr childThread = IntPtr.Zero;
            ControllerWatch controllerWatch = null;
            bool childCreated = false;
            bool childAssigned = false;
            string canonicalSessionId = String.Empty;
            string canonicalTargetId = String.Empty;

            try
            {
                commandFile = Required(commandFile, "command-file");
                comspec = Required(comspec, "comspec");
                workingDirectory = Required(workingDirectory, "working directory");
                title = Required(title, "title");
                canonicalSessionId = RequiredUuid(sessionId, "session ID");
                canonicalTargetId = RequiredUuid(targetId, "target ID");
                targetToken = Required(targetToken, "target token");
                readyFile = Required(readyFile, "ready-file");
                stoppingFile = Required(stoppingFile, "stopping-file");
                stoppedFile = Required(stoppedFile, "stopped-file");
                failedFile = Required(failedFile, "failed-file");
                forcedFile = Required(forcedFile, "forced-file");

                if (commandFile.IndexOf('%') >= 0)
                {
                    throw new InvalidOperationException(
                        "Command-file paths containing percent signs are unsupported.");
                }
                if (!File.Exists(commandFile))
                {
                    throw new FileNotFoundException(
                        "Command file does not exist.", commandFile);
                }
                if (!Directory.Exists(workingDirectory))
                {
                    throw new DirectoryNotFoundException(
                        "Working directory does not exist or is not a directory.");
                }
                if (!File.Exists(targetToken))
                {
                    throw new InvalidOperationException(
                        "Target ownership token disappeared before launch.");
                }
                if (!String.IsNullOrEmpty(shutdownToken) &&
                    !File.Exists(shutdownToken))
                {
                    throw new InvalidOperationException(
                        "Supervisor shutdown token disappeared before launch.");
                }

                Environment.SetEnvironmentVariable(
                    "TERMINAL_WINDOWS_COMMAND_FILE",
                    commandFile,
                    EnvironmentVariableTarget.Process);

                if (supervisorPid != 0)
                {
                    supervisor = OpenProcess(SYNCHRONIZE, false, supervisorPid);
                    if (supervisor == IntPtr.Zero)
                    {
                        ThrowLastError(
                            "Unable to retain supervisor process handle");
                    }
                }

                controllerWatch = ControllerWatch.Connect(
                    controlEndpoint,
                    controlToken,
                    canonicalSessionId,
                    canonicalTargetId);

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    ThrowLastError("CreateJobObject failed");
                }
                ConfigureKillOnClose(job);

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.lpTitle = title;
                PROCESS_INFORMATION child;
                StringBuilder commandLine = new StringBuilder(
                    QuoteCreateProcessArgument(comspec) +
                    " /d /v:off /c call " +
                    "\"%TERMINAL_WINDOWS_COMMAND_FILE%\"");
                uint flags =
                    CREATE_SUSPENDED |
                    CREATE_NEW_CONSOLE |
                    CREATE_UNICODE_ENVIRONMENT;
                if (!CreateProcess(
                        comspec,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        false,
                        flags,
                        IntPtr.Zero,
                        workingDirectory,
                        ref startup,
                        out child))
                {
                    ThrowLastError("CreateProcess failed");
                }
                childCreated = true;
                childProcess = child.hProcess;
                childThread = child.hThread;

                if (!AssignProcessToJobObject(job, childProcess))
                {
                    ThrowLastError("AssignProcessToJobObject failed");
                }
                childAssigned = true;
                AttachManagedConsole(child.dwProcessId);
                if (ResumeThread(childThread) == UInt32.MaxValue)
                {
                    ThrowLastError("ResumeThread failed");
                }
                Close(ref childThread);

                if (controllerWatch != null)
                {
                    controllerWatch.SendState("ready");
                }
                WriteStateMarker(
                    readyFile,
                    canonicalSessionId,
                    canonicalTargetId,
                    "ready");

                bool shutdownRequested = false;
                while (!IsJobEmpty(job))
                {
                    if (!File.Exists(targetToken) ||
                        (!String.IsNullOrEmpty(shutdownToken) &&
                         !File.Exists(shutdownToken)) ||
                        (supervisor != IntPtr.Zero &&
                         SupervisorExited(supervisor)) ||
                        (controllerWatch != null &&
                         controllerWatch.IsDisconnected()))
                    {
                        shutdownRequested = true;
                        break;
                    }
                    Thread.Sleep(100);
                }

                if (shutdownRequested && !IsJobEmpty(job))
                {
                    if (controllerWatch != null)
                    {
                        controllerWatch.TrySendState("stopping");
                    }
                    WriteStateMarker(
                        stoppingFile,
                        canonicalSessionId,
                        canonicalTargetId,
                        "stopping");
                    TrySendCtrlBreak();
                    if (!WaitForJobEmpty(job, graceMs))
                    {
                        WriteStateMarker(
                            forcedFile,
                            canonicalSessionId,
                            canonicalTargetId,
                            "forced");
                        if (!TerminateJobObject(job, 143))
                        {
                            ThrowLastError("TerminateJobObject failed");
                        }
                        if (!WaitForJobEmpty(job, forceWaitMs))
                        {
                            throw new InvalidOperationException(
                                "Job Object remained active after forced termination.");
                        }
                    }
                }

                if (controllerWatch != null)
                {
                    controllerWatch.TrySendState("stopped");
                }
                WriteStateMarker(
                    stoppedFile,
                    canonicalSessionId,
                    canonicalTargetId,
                    "stopped");
                return 0;
            }
            catch (Exception error)
            {
                bool terminationConfirmed = !childCreated;
                if (childCreated && !childAssigned &&
                    childProcess != IntPtr.Zero)
                {
                    if (TerminateProcess(childProcess, 1) &&
                        WaitForSingleObject(childProcess, forceWaitMs) ==
                            WAIT_OBJECT_0)
                    {
                        terminationConfirmed = true;
                    }
                }
                if (childAssigned && job != IntPtr.Zero)
                {
                    try
                    {
                        if (!IsJobPossiblyActive(job))
                        {
                            terminationConfirmed = true;
                        }
                        else
                        {
                            TryWriteStateMarker(
                                forcedFile,
                                canonicalSessionId,
                                canonicalTargetId,
                                "forced");
                            if (TerminateJobObject(job, 1) &&
                                WaitForJobEmpty(job, forceWaitMs))
                            {
                                terminationConfirmed = true;
                            }
                        }
                    }
                    catch
                    {
                        terminationConfirmed = false;
                    }
                }
                if (terminationConfirmed)
                {
                    TryWriteStateMarker(
                        failedFile,
                        canonicalSessionId,
                        canonicalTargetId,
                        "failed");
                }
                TryReportError(error);
                return 1;
            }
            finally
            {
                try
                {
                    Close(ref childThread);
                    Close(ref childProcess);
                    Close(ref supervisor);
                    if (controllerWatch != null)
                    {
                        controllerWatch.Dispose();
                    }
                }
                finally
                {
                    // Closing this kill-on-close handle cannot be skipped even
                    // if named-pipe cleanup throws.
                    Close(ref job);
                }
            }
        }
    }
}
'@

$payload = $null
$payloadDirectory = $null
$expectedSessionId = $null
$expectedTargetId = $null
$runEntered = $false
try {
  if ($SelfTest) {
    Add-Type -TypeDefinition $controllerSource -Language CSharp -ErrorAction Stop
    $selfTestExitCode = [TerminalWindows.PowerShellController]::SelfTest()
    exit $selfTestExitCode
  }

  if ([string]::IsNullOrWhiteSpace($PayloadPath)) {
    throw 'Missing required controller payload path.'
  }
  $payloadFullPath = [IO.Path]::GetFullPath($PayloadPath)
  $payloadDirectory = [IO.Path]::GetDirectoryName($payloadFullPath)
  try {
    $payloadFileName = [IO.Path]::GetFileName($payloadFullPath)
    $payloadSuffix = '.controller.json'
    if (-not $payloadFileName.EndsWith($payloadSuffix, [StringComparison]::Ordinal)) {
      throw 'Controller payload filename is invalid.'
    }
    $payloadIdentity = $payloadFileName.Substring(0, $payloadFileName.Length - $payloadSuffix.Length)
    $identitySeparator = $payloadIdentity.IndexOf('.')
    if ($identitySeparator -le 0 -or $identitySeparator -ne $payloadIdentity.LastIndexOf('.')) {
      throw 'Controller payload filename is invalid.'
    }
    $expectedSessionId = $payloadIdentity.Substring(0, $identitySeparator)
    $expectedTargetId = $payloadIdentity.Substring($identitySeparator + 1)
    $payloadJson = [IO.File]::ReadAllText($payloadFullPath, [Text.Encoding]::UTF8)
    $payload = $payloadJson | ConvertFrom-Json -ErrorAction Stop
    if (-not [String]::Equals(
        [string] $payload.sessionId,
        $expectedSessionId,
        [StringComparison]::Ordinal
      ) -or -not [String]::Equals(
        [string] $payload.targetId,
        $expectedTargetId,
        [StringComparison]::Ordinal
      )) {
      throw 'Controller payload identity does not match its filename.'
    }
  } finally {
    # The payload contains target environment values and the authenticated
    # control token. It must not remain on disk once parsing has finished.
    [IO.File]::Delete($payloadFullPath)
    if ([IO.File]::Exists($payloadFullPath)) {
      throw 'Controller payload deletion could not be confirmed.'
    }
  }

  # Parse and delete the secret-bearing payload before compiling. Target
  # environment variables are still applied only after compilation succeeds.
  Add-Type -TypeDefinition $controllerSource -Language CSharp -ErrorAction Stop
  foreach ($entry in $payload.environment) {
    [TerminalWindows.PowerShellController]::SetProcessEnvironmentVariable(
      [string] $entry.key,
      [string] $entry.value
    )
  }
  [TerminalWindows.PowerShellController]::SetProcessEnvironmentVariable(
    'TERMINAL_WINDOWS_EXIT_MESSAGE_FILE',
    [string] $payload.exitMessageFile
  )

  $commandFile = [string] $payload.commandFile
  $comspec = [string] $payload.comspec
  $workingDirectory = [string] $payload.cwd
  $title = [string] $payload.title
  $sessionId = [string] $payload.sessionId
  $targetId = [string] $payload.targetId
  $targetToken = [string] $payload.targetToken
  $readyFile = [string] $payload.readyFile
  $stoppingFile = [string] $payload.stoppingFile
  $stoppedFile = [string] $payload.stoppedFile
  $failedFile = [string] $payload.failedFile
  $forcedFile = [string] $payload.forcedFile
  $graceMs = [UInt32] $payload.graceMs
  $forceWaitMs = [UInt32] $payload.forceWaitMs
  $supervisorPid = [UInt32] $payload.supervisorPid
  $shutdownToken = [string] $payload.shutdownToken
  $controlEndpoint = [string] $payload.controlEndpoint
  $controlToken = [string] $payload.controlToken

  $runEntered = $true
  $exitCode = [TerminalWindows.PowerShellController]::Run(
    $commandFile,
    $comspec,
    $workingDirectory,
    $title,
    $sessionId,
    $targetId,
    $targetToken,
    $readyFile,
    $stoppingFile,
    $stoppedFile,
    $failedFile,
    $forcedFile,
    $graceMs,
    $forceWaitMs,
    $supervisorPid,
    $shutdownToken,
    $controlEndpoint,
    $controlToken
  )
  exit $exitCode
} catch {
  $launchError = $_
  if (-not $runEntered -and $null -ne $payload) {
    Write-PreLaunchFailureMarker $payload $payloadDirectory $expectedSessionId $expectedTargetId
  }
  [Console]::Error.WriteLine($launchError.Exception.GetBaseException().Message)
  exit 1
}
