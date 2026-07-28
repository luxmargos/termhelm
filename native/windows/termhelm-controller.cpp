#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

namespace {

constexpr DWORD kCreateFlags =
    CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;

class UniqueHandle {
 public:
  UniqueHandle() noexcept = default;
  explicit UniqueHandle(HANDLE value) noexcept : value_(value) {}
  ~UniqueHandle() { reset(); }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  HANDLE get() const noexcept { return value_; }
  explicit operator bool() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() noexcept {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) noexcept {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

[[noreturn]] void Fail(const std::string& message) {
  throw std::runtime_error(message);
}

[[noreturn]] void FailWindows(const std::string& operation) {
  Fail(operation + " (Windows error " + std::to_string(GetLastError()) + ")");
}

std::map<std::wstring, std::wstring> ParseArguments(int argc,
                                                    wchar_t** argv) {
  if ((argc - 1) % 2 != 0) {
    Fail("Controller arguments must be --name value pairs.");
  }

  std::map<std::wstring, std::wstring> parsed;
  for (int index = 1; index < argc; index += 2) {
    const std::wstring flag(argv[index]);
    if (flag.rfind(L"--", 0) != 0 || flag.size() == 2) {
      Fail("Invalid controller argument.");
    }
    const std::wstring name = flag.substr(2);
    if (!parsed.emplace(name, argv[index + 1]).second) {
      Fail("Duplicate controller argument.");
    }
  }
  return parsed;
}

const std::wstring& Required(
    const std::map<std::wstring, std::wstring>& options,
    const std::wstring& name) {
  const auto found = options.find(name);
  if (found == options.end() || found->second.empty()) {
    Fail("Missing required controller argument.");
  }
  return found->second;
}

std::wstring Optional(const std::map<std::wstring, std::wstring>& options,
                      const std::wstring& name) {
  const auto found = options.find(name);
  return found == options.end() ? L"" : found->second;
}

bool IsHex(wchar_t character) {
  return (character >= L'0' && character <= L'9') ||
         (character >= L'a' && character <= L'f') ||
         (character >= L'A' && character <= L'F');
}

std::wstring RequiredUuid(
    const std::map<std::wstring, std::wstring>& options,
    const std::wstring& name) {
  std::wstring value = Required(options, name);
  if (value.size() != 36) Fail("Invalid controller UUID.");
  for (std::size_t index = 0; index < value.size(); ++index) {
    const bool dash = index == 8 || index == 13 || index == 18 || index == 23;
    if ((dash && value[index] != L'-') || (!dash && !IsHex(value[index]))) {
      Fail("Invalid controller UUID.");
    }
    if (value[index] >= L'A' && value[index] <= L'F') {
      value[index] = static_cast<wchar_t>(value[index] - L'A' + L'a');
    }
  }
  return value;
}

DWORD RequiredDword(const std::map<std::wstring, std::wstring>& options,
                    const std::wstring& name) {
  const std::wstring& value = Required(options, name);
  if (value.empty() ||
      !std::all_of(value.begin(), value.end(),
                   [](wchar_t character) {
                     return character >= L'0' && character <= L'9';
                   })) {
    Fail("Invalid unsigned integer controller argument.");
  }

  unsigned long long parsed = 0;
  try {
    std::size_t consumed = 0;
    parsed = std::stoull(value, &consumed, 10);
    if (consumed != value.size()) Fail("Invalid controller integer.");
  } catch (const std::exception&) {
    Fail("Invalid controller integer.");
  }
  if (parsed > std::numeric_limits<DWORD>::max()) {
    Fail("Controller integer is out of range.");
  }
  return static_cast<DWORD>(parsed);
}

bool FileExists(const std::wstring& path) {
  if (path.empty()) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring QuoteCreateProcessArgument(const std::wstring& value) {
  std::wstring quoted(1, L'"');
  std::size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

void ConfigureKillOnClose(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    FailWindows("SetInformationJobObject failed");
  }
}

bool IsJobEmpty(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &accounting, sizeof(accounting), nullptr)) {
    FailWindows("QueryInformationJobObject failed");
  }
  return accounting.ActiveProcesses == 0;
}

bool IsJobPossiblyActive(HANDLE job) noexcept {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &accounting, sizeof(accounting), nullptr)) {
    return true;
  }
  return accounting.ActiveProcesses != 0;
}

bool WaitForJobEmpty(HANDLE job, DWORD timeout_ms) {
  const ULONGLONG deadline = GetTickCount64() + timeout_ms;
  if (IsJobEmpty(job)) return true;
  for (;;) {
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) break;
    const ULONGLONG remaining = deadline - now;
    Sleep(static_cast<DWORD>(std::min<ULONGLONG>(50, remaining)));
    if (IsJobEmpty(job)) return true;
  }
  return IsJobEmpty(job);
}

BOOL WINAPI IgnoreManagedConsoleControl(DWORD) { return TRUE; }

void AttachManagedConsole(DWORD suspended_process_id) {
  FreeConsole();
  if (!AttachConsole(suspended_process_id)) {
    FailWindows("AttachConsole failed");
  }
  // AttachConsole resets the handler table. CTRL_BREAK cannot be suppressed by
  // SetConsoleCtrlHandler(nullptr, TRUE), so install an explicit handler before
  // broadcasting to this controller's dedicated console.
  if (!SetConsoleCtrlHandler(IgnoreManagedConsoleControl, TRUE)) {
    FailWindows("SetConsoleCtrlHandler failed");
  }
}

void TrySendCtrlBreak() noexcept {
  // Group zero addresses every process currently attached to the dedicated
  // managed console. The child PID was used only while the retained child was
  // suspended to attach this controller; it is never reused as kill authority.
  GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
  Sleep(50);
}

int RunSelfTest() {
  UniqueHandle job;
  UniqueHandle child_process;
  UniqueHandle child_thread;
  bool child_created = false;
  bool child_assigned = false;

  try {
    job.reset(CreateJobObjectW(nullptr, nullptr));
    if (!job) FailWindows("Self-test CreateJobObject failed");
    ConfigureKillOnClose(job.get());

    std::wstring comspec = L"cmd.exe";
    const DWORD comspec_length = GetEnvironmentVariableW(L"ComSpec", nullptr, 0);
    if (comspec_length != 0) {
      std::vector<wchar_t> comspec_buffer(comspec_length);
      const DWORD copied = GetEnvironmentVariableW(
          L"ComSpec", comspec_buffer.data(),
          static_cast<DWORD>(comspec_buffer.size()));
      if (copied == 0 || copied >= comspec_buffer.size()) {
        FailWindows("Self-test could not read ComSpec");
      }
      comspec.assign(comspec_buffer.data(), copied);
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION child{};
    std::wstring command_line =
        QuoteCreateProcessArgument(comspec) + L" /d /q /c exit /b 0";
    std::vector<wchar_t> mutable_command_line(command_line.begin(),
                                              command_line.end());
    mutable_command_line.push_back(L'\0');

    constexpr DWORD self_test_flags =
        CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;
    if (!CreateProcessW(comspec.c_str(), mutable_command_line.data(), nullptr,
                        nullptr, FALSE, self_test_flags, nullptr, nullptr,
                        &startup, &child)) {
      FailWindows("Self-test CreateProcess failed");
    }
    child_created = true;
    child_process.reset(child.hProcess);
    child_thread.reset(child.hThread);

    if (!AssignProcessToJobObject(job.get(), child_process.get())) {
      FailWindows("Self-test AssignProcessToJobObject failed");
    }
    child_assigned = true;
    AttachManagedConsole(child.dwProcessId);
    if (ResumeThread(child_thread.get()) == std::numeric_limits<DWORD>::max()) {
      FailWindows("Self-test ResumeThread failed");
    }
    child_thread.reset();

    const DWORD process_wait = WaitForSingleObject(child_process.get(), 5000);
    if (process_wait == WAIT_FAILED) {
      FailWindows("Self-test child wait failed");
    }
    if (process_wait != WAIT_OBJECT_0) {
      if (!TerminateJobObject(job.get(), 1)) {
        FailWindows("Self-test timed out and could not terminate its Job Object");
      }
      if (!WaitForJobEmpty(job.get(), 5000)) {
        Fail("Self-test timed out and its Job Object remained active.");
      }
      Fail("Self-test command did not exit within its deadline.");
    }

    DWORD exit_code = 1;
    if (!GetExitCodeProcess(child_process.get(), &exit_code)) {
      FailWindows("Self-test could not read its child exit code");
    }
    if (exit_code != 0) {
      Fail("Self-test command returned a non-zero exit code.");
    }
    if (!WaitForJobEmpty(job.get(), 5000)) {
      Fail("Self-test Job Object did not become empty.");
    }
    return 0;
  } catch (...) {
    if (child_created && !child_assigned && child_process) {
      if (!TerminateProcess(child_process.get(), 1) && child_thread) {
        // The self-test payload is an inert `exit 0`; if an unusual policy
        // rejects TerminateProcess before assignment, let that harmless
        // suspended payload finish instead of stranding it.
        ResumeThread(child_thread.get());
      }
      WaitForSingleObject(child_process.get(), 5000);
    }
    if (child_assigned && job && IsJobPossiblyActive(job.get())) {
      TerminateJobObject(job.get(), 1);
      try {
        WaitForJobEmpty(job.get(), 5000);
      } catch (...) {
        // Closing the kill-on-close Job handle remains the last safety net.
      }
    }
    throw;
  }
}

std::string Ascii(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (const wchar_t character : value) {
    if (character > 0x7f) Fail("Expected ASCII value.");
    result.push_back(static_cast<char>(character));
  }
  return result;
}

std::string Timestamp() {
  SYSTEMTIME now{};
  GetSystemTime(&now);
  char buffer[32]{};
  const int written = sprintf_s(
      buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
      static_cast<unsigned>(now.wYear), static_cast<unsigned>(now.wMonth),
      static_cast<unsigned>(now.wDay), static_cast<unsigned>(now.wHour),
      static_cast<unsigned>(now.wMinute), static_cast<unsigned>(now.wSecond),
      static_cast<unsigned>(now.wMilliseconds));
  if (written <= 0) Fail("Unable to format marker timestamp.");
  return std::string(buffer, static_cast<std::size_t>(written));
}

void WriteAll(HANDLE file, const std::string& content) {
  std::size_t offset = 0;
  while (offset < content.size()) {
    const std::size_t remaining = content.size() - offset;
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(
        remaining, std::numeric_limits<DWORD>::max()));
    DWORD written = 0;
    if (!WriteFile(file, content.data() + offset, request, &written, nullptr)) {
      FailWindows("Writing marker failed");
    }
    if (written == 0) Fail("Writing marker made no progress.");
    offset += written;
  }
}

UniqueHandle ConnectControllerWatch(const std::wstring& endpoint,
                                    const std::wstring& token,
                                    const std::wstring& session_id,
                                    const std::wstring& target_id) {
  if (endpoint.empty() && token.empty()) return UniqueHandle();
  if (endpoint.empty() || token.empty()) {
    Fail("Controller endpoint and authentication token must be provided together.");
  }
  if (token.size() < 32 || token.size() > 256 ||
      token.find_first_not_of(
          L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") !=
          std::wstring::npos) {
    Fail("Controller authentication token is invalid.");
  }
  if (!WaitNamedPipeW(endpoint.c_str(), 5000)) {
    FailWindows("Timed out waiting for the managed controller named pipe");
  }
  UniqueHandle pipe(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE,
                                0, nullptr, OPEN_EXISTING, 0, nullptr));
  if (!pipe) FailWindows("Opening managed controller named pipe failed");

  const std::string target = Ascii(target_id);
  const std::string request =
      "{\"type\":\"watch\",\"authenticationToken\":\"" + Ascii(token) +
      "\",\"requestId\":\"" + target + "\",\"sessionId\":\"" +
      Ascii(session_id) + "\",\"targetId\":\"" + target + "\"}\n";
  WriteAll(pipe.get(), request);

  std::string response;
  response.reserve(128);
  while (response.size() <= 4096) {
    char character = 0;
    DWORD read = 0;
    if (!ReadFile(pipe.get(), &character, 1, &read, nullptr) || read != 1) {
      FailWindows("Reading managed controller watch acknowledgement failed");
    }
    if (character == '\n') break;
    response.push_back(character);
  }
  const std::string expected =
      "{\"type\":\"watching\",\"requestId\":\"" + target + "\"}";
  if (response != expected) Fail("Managed controller watch authentication failed.");
  return pipe;
}

bool ControllerWatchDisconnected(HANDLE pipe) noexcept {
  if (pipe == nullptr || pipe == INVALID_HANDLE_VALUE) return false;
  DWORD available = 0;
  return !PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr);
}

void SendControllerState(HANDLE pipe, const char* state) {
  if (pipe == nullptr || pipe == INVALID_HANDLE_VALUE) return;
  WriteAll(pipe, "{\"type\":\"state\",\"state\":\"" +
                     std::string(state) + "\"}\n");
}

void TrySendControllerState(HANDLE pipe, const char* state) noexcept {
  try {
    SendControllerState(pipe, state);
  } catch (...) {
    // Recovery markers remain authoritative if the supervisor disconnected.
  }
}

std::wstring TemporaryMarkerPath(const std::wstring& path,
                                 unsigned int attempt) {
  return path + L"." + std::to_wstring(GetCurrentProcessId()) + L"." +
         std::to_wstring(GetTickCount64()) + L"." +
         std::to_wstring(attempt) + L".tmp";
}

void WriteStateMarker(const std::wstring& path, const std::wstring& session_id,
                      const std::wstring& target_id, const char* state,
                      int version) {
  if (path.empty() || session_id.empty() || target_id.empty()) return;

  const std::filesystem::path marker_path(path);
  const std::filesystem::path parent = marker_path.parent_path();
  if (parent.empty()) Fail("Marker path must include a parent directory.");
  std::error_code directory_error;
  std::filesystem::create_directories(parent, directory_error);
  if (directory_error) Fail("Unable to create marker directory.");

  const std::string json =
      "{\"version\":" + std::to_string(version) +
      ",\"sessionId\":\"" + Ascii(session_id) +
      "\",\"targetId\":\"" + Ascii(target_id) +
      "\",\"state\":\"" + std::string(state) +
      "\",\"updatedAt\":\"" + Timestamp() + "\"}\n";

  std::wstring temporary_path;
  UniqueHandle temporary_file;
  for (unsigned int attempt = 0; attempt < 32; ++attempt) {
    temporary_path = TemporaryMarkerPath(path, attempt);
    HANDLE created = CreateFileW(
        temporary_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, nullptr);
    if (created != INVALID_HANDLE_VALUE) {
      temporary_file.reset(created);
      break;
    }
    if (GetLastError() != ERROR_FILE_EXISTS) {
      FailWindows("Creating temporary marker failed");
    }
  }
  if (!temporary_file) Fail("Unable to allocate a temporary marker path.");

  try {
    WriteAll(temporary_file.get(), json);
    if (!FlushFileBuffers(temporary_file.get())) {
      FailWindows("Flushing temporary marker failed");
    }
    temporary_file.reset();
    if (!MoveFileExW(temporary_path.c_str(), path.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      FailWindows("Publishing marker failed");
    }
  } catch (...) {
    temporary_file.reset();
    DeleteFileW(temporary_path.c_str());
    throw;
  }
}

void TryWriteStateMarker(const std::wstring& path,
                         const std::wstring& session_id,
                         const std::wstring& target_id, const char* state,
                         int version) noexcept {
  try {
    WriteStateMarker(path, session_id, target_id, state, version);
  } catch (...) {
    // The owner may already have removed its private control directory.
  }
}

bool SupervisorExited(HANDLE supervisor) {
  const DWORD result = WaitForSingleObject(supervisor, 0);
  if (result == WAIT_OBJECT_0) return true;
  if (result == WAIT_TIMEOUT) return false;
  FailWindows("Waiting for the supervisor failed");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
    try {
      return RunSelfTest();
    } catch (const std::exception& error) {
      std::cerr << error.what() << '\n';
      return 1;
    }
  }

  std::wstring failed_file;
  std::wstring forced_file;
  std::wstring session_id;
  std::wstring target_id;
  UniqueHandle job;
  UniqueHandle supervisor;
  UniqueHandle child_process;
  UniqueHandle child_thread;
  UniqueHandle controller_watch;
  bool child_created = false;
  bool child_assigned = false;
  DWORD force_wait_ms = 0;

  try {
    const auto options = ParseArguments(argc, argv);
    const std::wstring command_file = Required(options, L"command-file");
    const std::wstring comspec = Required(options, L"comspec");
    const std::wstring working_directory = Required(options, L"cwd");
    std::wstring title = Required(options, L"title");
    session_id = RequiredUuid(options, L"session-id");
    target_id = RequiredUuid(options, L"target-id");
    const std::wstring target_token = Required(options, L"target-token");
    const std::wstring ready_file = Required(options, L"ready-file");
    const std::wstring stopping_file = Required(options, L"stopping-file");
    const std::wstring stopped_file = Required(options, L"stopped-file");
    failed_file = Required(options, L"failed-file");
    forced_file = Required(options, L"forced-file");
    const DWORD grace_ms = RequiredDword(options, L"grace-ms");
    force_wait_ms = RequiredDword(options, L"force-wait-ms");
    const DWORD supervisor_pid = RequiredDword(options, L"supervisor-pid");
    const std::wstring shutdown_token = Optional(options, L"shutdown-token");
    const std::wstring control_endpoint = Optional(options, L"control-endpoint");
    const std::wstring control_token = Optional(options, L"control-token");

    // cmd.exe CALL performs an additional percent-expansion pass. Reject a
    // command-file path that could become command text during that pass; the
    // command payload itself remains the only intentionally interpreted text.
    if (command_file.find(L'%') != std::wstring::npos) {
      Fail("Command-file paths containing percent signs are unsupported.");
    }
    if (!FileExists(command_file)) Fail("Command file does not exist.");
    const DWORD working_directory_attributes =
        GetFileAttributesW(working_directory.c_str());
    if (working_directory_attributes == INVALID_FILE_ATTRIBUTES ||
        (working_directory_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      Fail("Working directory does not exist or is not a directory.");
    }
    if (!FileExists(target_token)) {
      Fail("Target ownership token disappeared before launch.");
    }
    if (!shutdown_token.empty() && !FileExists(shutdown_token)) {
      Fail("Supervisor shutdown token disappeared before launch.");
    }

    if (!SetEnvironmentVariableW(L"TERMHELM_COMMAND_FILE",
                                 command_file.c_str())) {
      FailWindows("Unable to set the structural command-file environment variable");
    }

    if (supervisor_pid != 0) {
      supervisor.reset(OpenProcess(SYNCHRONIZE, FALSE, supervisor_pid));
      if (!supervisor) FailWindows("Unable to retain supervisor process handle");
    }

    controller_watch = ConnectControllerWatch(
        control_endpoint, control_token, session_id, target_id);

    job.reset(CreateJobObjectW(nullptr, nullptr));
    if (!job) FailWindows("CreateJobObject failed");
    ConfigureKillOnClose(job.get());

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.lpTitle = title.data();
    PROCESS_INFORMATION child{};
    std::wstring command_line = QuoteCreateProcessArgument(comspec) +
                                L" /d /v:off /c call "
                                L"\"%TERMHELM_COMMAND_FILE%\"";
    std::vector<wchar_t> mutable_command_line(command_line.begin(),
                                              command_line.end());
    mutable_command_line.push_back(L'\0');

    if (!CreateProcessW(comspec.c_str(), mutable_command_line.data(), nullptr,
                        nullptr, FALSE, kCreateFlags, nullptr,
                        working_directory.c_str(), &startup, &child)) {
      FailWindows("CreateProcess failed");
    }
    child_created = true;
    child_process.reset(child.hProcess);
    child_thread.reset(child.hThread);

    if (!AssignProcessToJobObject(job.get(), child_process.get())) {
      FailWindows("AssignProcessToJobObject failed");
    }
    child_assigned = true;
    AttachManagedConsole(child.dwProcessId);
    if (ResumeThread(child_thread.get()) == std::numeric_limits<DWORD>::max()) {
      FailWindows("ResumeThread failed");
    }
    child_thread.reset();

    SendControllerState(controller_watch.get(), "ready");
    WriteStateMarker(ready_file, session_id, target_id, "ready", 2);

    bool shutdown_requested = false;
    while (!IsJobEmpty(job.get())) {
      if (!FileExists(target_token) ||
          (!shutdown_token.empty() && !FileExists(shutdown_token)) ||
          (supervisor && SupervisorExited(supervisor.get())) ||
          ControllerWatchDisconnected(controller_watch.get())) {
        shutdown_requested = true;
        break;
      }
      Sleep(100);
    }

    if (shutdown_requested && !IsJobEmpty(job.get())) {
      TrySendControllerState(controller_watch.get(), "stopping");
      WriteStateMarker(stopping_file, session_id, target_id, "stopping", 2);
      TrySendCtrlBreak();
      if (!WaitForJobEmpty(job.get(), grace_ms)) {
        WriteStateMarker(forced_file, session_id, target_id, "forced", 2);
        if (!TerminateJobObject(job.get(), 143)) {
          FailWindows("TerminateJobObject failed");
        }
        if (!WaitForJobEmpty(job.get(), force_wait_ms)) {
          Fail("Job Object remained active after forced termination.");
        }
      }
    }

    TrySendControllerState(controller_watch.get(), "stopped");
    WriteStateMarker(stopped_file, session_id, target_id, "stopped", 2);
    return 0;
  } catch (const std::exception& error) {
    bool termination_confirmed = !child_created;
    if (child_created && !child_assigned && child_process) {
      if (TerminateProcess(child_process.get(), 1) &&
          WaitForSingleObject(child_process.get(), force_wait_ms) ==
              WAIT_OBJECT_0) {
        termination_confirmed = true;
      }
    }
    if (child_assigned && job) {
      try {
        if (!IsJobPossiblyActive(job.get())) {
          termination_confirmed = true;
        } else {
          TryWriteStateMarker(forced_file, session_id, target_id, "forced", 2);
          if (TerminateJobObject(job.get(), 1) &&
              WaitForJobEmpty(job.get(), force_wait_ms)) {
            termination_confirmed = true;
          }
        }
      } catch (...) {
        // Closing the Job handle remains a final safety net, but without an
        // empty-Job acknowledgement the supervisor must retain its record.
        termination_confirmed = false;
      }
    }
    if (termination_confirmed) {
      TryWriteStateMarker(failed_file, session_id, target_id, "failed", 2);
    }
    std::cerr << error.what() << '\n';
    return 1;
  }
}
