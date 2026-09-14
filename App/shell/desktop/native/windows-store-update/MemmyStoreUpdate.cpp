#include <windows.h>
#include <appmodel.h>
#include <exdisp.h>
#include <shldisp.h>
#include <servprov.h>
#include <sddl.h>
#include <shlobj_core.h>
#include <shobjidl_core.h>
#include <tlhelp32.h>
#include <wincrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>
#include <winrt/base.h>
#include "LegacyProcessStop.h"
#include "StoreInstallShutdown.h"

using namespace winrt;
using namespace Windows::ApplicationModel;
using namespace Windows::Foundation;
using namespace Windows::Foundation::Collections;
using namespace Windows::Services::Store;

namespace
{
    enum class Command
    {
        Identity,
        PackageFamilyRegistration,
        Check,
        DownloadSilent,
        DownloadUser,
        HandoffInstall,
        LaunchStoreUpdateFinalizer,
        FinalizeStoreUpdate,
        StartupStatus,
        StartupEnable,
        StartupDisable,
        PrepareLegacyTakeover,
        StopLegacyForDataImport,
        CreateStoreShortcut,
        DiscoverLegacyInstallation,
        LaunchDiscoveredLegacyCleanup,
        RunDiscoveredLegacyCleanup,
        RecoverLegacyCleanupJournal,
        EnsureLegacyCleanupBroker,
        LegacyCleanupBroker,
        StopLegacyCleanupBroker,
        AuthorizeNsisMutation,
        FinalizeLegacyCleanup,
        AckLegacyCleanup,
        FinalizeLegacyCleanupBreakawayLauncher,
        FinalizeLegacyCleanupUnpackaged
    };

    constexpr wchar_t store_startup_task_id[] = L"MemmyStartupTask";
    constexpr wchar_t legacy_app_user_model_id[] = L"cn.memtensor.memmy";
    constexpr wchar_t legacy_cleanup_broker_run_value[] =
        L"Memmy Store Transition Broker";
    constexpr wchar_t legacy_cleanup_broker_run_key[] =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    constexpr wchar_t legacy_transition_mutation_mutex_name[] =
        L"Local\\MemmyStoreTransitionNsisMutation";
    constexpr wchar_t allowed_memmy_package_family[] =
        L"Memtensor.Memmy_eyack96k521x2";
    constexpr wchar_t allowed_memmy_agent_package_family[] =
        L"Memtensor.MemmyAgent_eyack96k521x2";

    struct StoreInstallHandoffOptions
    {
        std::filesystem::path external_helper_path;
        std::filesystem::path state_path;
        std::filesystem::path result_path;
        std::filesystem::path log_path;
        DWORD old_process_id = 0;
        std::wstring baseline_package_version;
        std::wstring baseline_package_full_name;
        std::wstring created_at;
        std::wstring aumid;
        std::wstring package_family_name;
        std::wstring mode;
    };

    struct StoreInstallResultFile
    {
        bool available = false;
        std::string state;
        std::string hresult;
        std::string reason;
    };

    struct LegacyTransitionOptions
    {
        std::filesystem::path external_helper_path;
        std::filesystem::path legacy_install_directory;
        std::filesystem::path legacy_executable_path;
        std::filesystem::path shortcut_path;
        std::wstring aumid;
        std::wstring package_family_name;
        std::wstring transition_id;
        std::wstring attempt_id;
        std::wstring legacy_install_fingerprint;
    };

    struct DeleteTreeResult
    {
        DWORD win32_error = ERROR_SUCCESS;
        std::filesystem::path failed_path;
        std::string operation;
    };

    struct LegacyCleanupProcessResult
    {
        bool available = false;
        HRESULT hresult = E_FAIL;
        std::string process_role;
        std::string failure_process_role;
        std::string transition_id;
        std::string attempt_id;
        std::optional<DWORD> win32_error;
        std::string operation;
        std::string target;
        std::string message;
    };

    struct LegacyCleanupDiagnostics
    {
        std::filesystem::path directory_path;
        std::filesystem::path log_path;
        std::string process_role;
        std::string failure_process_role;
        std::string transition_id;
        std::string attempt_id;
        DWORD process_id = 0;
        DWORD session_id = 0;
        bool session_id_available = false;
        LONG package_identity_result = ERROR_SUCCESS;
        bool has_package_identity = false;
        std::string package_full_name;
        std::string current_operation;
        std::string current_target;
        std::optional<DWORD> current_win32_error;
    };

    enum class LegacyCleanupBrokerMessage : uint32_t
    {
        Ping = 1,
        Cleanup = 2,
        Stop = 3,
        Acknowledge = 4,
        Response = 5
    };

    struct LegacyCleanupBrokerResponse
    {
        HRESULT hresult = S_OK;
        std::optional<DWORD> win32_error;
        std::wstring transition_id;
        std::wstring attempt_id;
        std::string operation;
        std::string target;
        std::string message;
    };

    struct LegacySourceExecutableIdentity
    {
        DWORD volume_serial_number = 0;
        uint64_t file_index = 0;
        uint64_t file_size = 0;
        uint64_t last_write_time = 0;
    };

    struct LegacyAuthorityCapture
    {
        std::wstring user_sid;
        DWORD session_id = 0;
        std::filesystem::path install_directory;
        std::optional<std::wstring> installer_32;
        std::optional<std::wstring> installer_64;
        std::optional<std::wstring> uninstall_32;
        std::optional<std::wstring> uninstall_64;
        std::optional<LegacySourceExecutableIdentity> source_executable_identity;
    };

    enum class LegacyCleanupJournalPhase : uint32_t
    {
        Prepared = 1,
        Complete = 2,
        Acknowledged = 3
    };

    struct LegacyCleanupJournal
    {
        LegacyCleanupJournalPhase phase = LegacyCleanupJournalPhase::Prepared;
        LegacyTransitionOptions options;
        LegacyAuthorityCapture authority;
    };

    class scoped_handle
    {
    public:
        scoped_handle() noexcept = default;
        explicit scoped_handle(HANDLE value) noexcept : value_(value) {}
        scoped_handle(const scoped_handle&) = delete;
        scoped_handle& operator=(const scoped_handle&) = delete;
        scoped_handle(scoped_handle&& other) noexcept : value_(other.release()) {}
        scoped_handle& operator=(scoped_handle&& other) noexcept
        {
            if (this != &other)
            {
                reset(other.release());
            }
            return *this;
        }
        ~scoped_handle() noexcept
        {
            reset();
        }
        HANDLE get() const noexcept { return value_; }
        explicit operator bool() const noexcept
        {
            return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
        }
        HANDLE release() noexcept
        {
            const HANDLE result = value_;
            value_ = INVALID_HANDLE_VALUE;
            return result;
        }
        void reset(HANDLE value = INVALID_HANDLE_VALUE) noexcept
        {
            if (*this)
            {
                CloseHandle(value_);
            }
            value_ = value;
        }

    private:
        HANDLE value_ = INVALID_HANDLE_VALUE;
    };

    class scoped_registry_key
    {
    public:
        scoped_registry_key() noexcept = default;
        explicit scoped_registry_key(HKEY value) noexcept : value_(value) {}
        scoped_registry_key(const scoped_registry_key&) = delete;
        scoped_registry_key& operator=(const scoped_registry_key&) = delete;
        ~scoped_registry_key() noexcept
        {
            if (value_ != nullptr)
            {
                RegCloseKey(value_);
            }
        }
        HKEY get() const noexcept { return value_; }

    private:
        HKEY value_ = nullptr;
    };

    class scoped_mutex_ownership
    {
    public:
        scoped_mutex_ownership() noexcept = default;
        scoped_mutex_ownership(const scoped_mutex_ownership&) = delete;
        scoped_mutex_ownership& operator=(const scoped_mutex_ownership&) = delete;
        ~scoped_mutex_ownership() noexcept
        {
            reset();
        }
        void acquire(HANDLE mutex)
        {
            reset();
            handle_ = mutex;
            const DWORD wait_result = WaitForSingleObject(handle_, 15000);
            if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED)
            {
                const DWORD error = wait_result == WAIT_TIMEOUT
                    ? ERROR_TIMEOUT
                    : GetLastError();
                handle_ = nullptr;
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to acquire the NSIS and Store transition mutation mutex");
            }
            owned_ = true;
        }
        void reset() noexcept
        {
            if (owned_ && handle_ != nullptr)
            {
                ReleaseMutex(handle_);
            }
            owned_ = false;
            handle_ = nullptr;
        }
    private:
        HANDLE handle_ = nullptr;
        bool owned_ = false;
    };

    std::optional<LegacyCleanupDiagnostics> legacy_cleanup_diagnostics;

    std::string utf8(const std::wstring& value);
    std::string utc_timestamp();
    std::string hresult_text(HRESULT value);
    std::string single_line(std::string value);
    bool append_legacy_cleanup_diagnostic(
        const std::string& event,
        const std::string& outcome = "",
        const std::string& operation = "",
        const std::string& target = "",
        std::optional<DWORD> win32_error = std::nullopt,
        std::optional<HRESULT> hresult = std::nullopt,
        const std::string& detail = "") noexcept;
    void begin_legacy_cleanup_operation(
        const std::string& operation,
        const std::string& target = "") noexcept;
    void complete_legacy_cleanup_operation(const std::string& detail = "") noexcept;
    void set_legacy_cleanup_failure_context(
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error = std::nullopt) noexcept;
    void write_text_file_atomic(
        const std::filesystem::path& target_path,
        const std::string& contents);
    void require_allowed_memmy_package_identity(
        const LegacyTransitionOptions& options);

    struct ProcessSnapshotEntry
    {
        DWORD process_id;
        DWORD parent_process_id;
        ULONGLONG creation_time;
        std::filesystem::path image_path;
        bool image_path_verified = false;
        std::wstring executable_name;
    };

    std::string escape_json(std::string_view value)
    {
        std::ostringstream output;
        for (const char character : value)
        {
            switch (character)
            {
            case '\\':
                output << "\\\\";
                break;
            case '"':
                output << "\\\"";
                break;
            case '\n':
                output << "\\n";
                break;
            case '\r':
                output << "\\r";
                break;
            case '\t':
                output << "\\t";
                break;
            default:
                if (static_cast<unsigned char>(character) < 0x20)
                {
                    output << "\\u"
                           << std::hex
                           << std::setw(4)
                           << std::setfill('0')
                           << static_cast<int>(static_cast<unsigned char>(character));
                }
                else
                {
                    output << character;
                }
            }
        }
        return output.str();
    }

    void write_json_line(const std::string& value)
    {
        std::cout << value << '\n';
        std::cout.flush();
    }

    std::string update_state_name(StorePackageUpdateState state)
    {
        switch (state)
        {
        case StorePackageUpdateState::Pending:
            return "pending";
        case StorePackageUpdateState::Downloading:
            return "downloading";
        case StorePackageUpdateState::Deploying:
            return "deploying";
        case StorePackageUpdateState::Completed:
            return "completed";
        case StorePackageUpdateState::Canceled:
            return "canceled";
        case StorePackageUpdateState::ErrorLowBattery:
            return "error-low-battery";
        case StorePackageUpdateState::ErrorWiFiRecommended:
            return "error-wifi-recommended";
        case StorePackageUpdateState::ErrorWiFiRequired:
            return "error-wifi-required";
        case StorePackageUpdateState::OtherError:
        default:
            return "other-error";
        }
    }

    std::string startup_task_state_name(StartupTaskState state)
    {
        switch (state)
        {
        case StartupTaskState::Disabled:
            return "disabled";
        case StartupTaskState::DisabledByUser:
            return "disabled-by-user";
        case StartupTaskState::DisabledByPolicy:
            return "disabled-by-policy";
        case StartupTaskState::Enabled:
        case StartupTaskState::EnabledByPolicy:
            return "enabled";
        default:
            throw hresult_error(E_UNEXPECTED, L"Windows returned an unknown StartupTask state");
        }
    }

    std::string package_version(const PackageVersion& version)
    {
        std::ostringstream output;
        output << version.Major << '.'
               << version.Minor << '.'
               << version.Build << '.'
               << version.Revision;
        return output.str();
    }

    std::string current_application_user_model_id()
    {
        UINT32 length = 0;
        LONG result = GetCurrentApplicationUserModelId(&length, nullptr);
        if (result != ERROR_INSUFFICIENT_BUFFER || length == 0)
        {
            throw hresult_error(HRESULT_FROM_WIN32(result), L"Current process has no application user model ID");
        }

        std::vector<wchar_t> value(length);
        result = GetCurrentApplicationUserModelId(&length, value.data());
        check_hresult(HRESULT_FROM_WIN32(result));
        return to_string(hstring(value.data()));
    }

    HWND parse_window_handle(const std::wstring& value)
    {
        if (value.empty())
        {
            return nullptr;
        }

        wchar_t* end = nullptr;
        const unsigned long long parsed = std::wcstoull(value.c_str(), &end, 10);
        if (end == value.c_str() || *end != L'\0' || parsed == 0)
        {
            throw hresult_invalid_argument(L"--hwnd must be a non-zero decimal window handle");
        }
        return reinterpret_cast<HWND>(static_cast<uintptr_t>(parsed));
    }

    bool is_valid_aumid(const std::wstring& value)
    {
        const auto separator = value.find(L'!');
        if (separator == std::wstring::npos ||
            separator == 0 ||
            separator == value.size() - 1 ||
            value.find(L'!', separator + 1) != std::wstring::npos)
        {
            return false;
        }
        return std::all_of(value.begin(), value.end(), [](wchar_t character)
        {
            return character == L'!' ||
                character == L'.' ||
                character == L'_' ||
                character == L'-' ||
                (character >= L'0' && character <= L'9') ||
                (character >= L'A' && character <= L'Z') ||
                (character >= L'a' && character <= L'z');
        });
    }

    bool is_canonical_uuid(const std::wstring& value)
    {
        if (value.size() != 36)
        {
            return false;
        }
        for (size_t index = 0; index < value.size(); ++index)
        {
            const wchar_t character = value[index];
            if (index == 8 || index == 13 || index == 18 || index == 23)
            {
                if (character != L'-')
                {
                    return false;
                }
                continue;
            }
            if (!((character >= L'0' && character <= L'9') ||
                  (character >= L'a' && character <= L'f') ||
                  (character >= L'A' && character <= L'F')))
            {
                return false;
            }
        }
        return true;
    }

    std::filesystem::path resolve_environment_path(
        const wchar_t* variable_name,
        const wchar_t* failure_context)
    {
        const DWORD required_length = GetEnvironmentVariableW(variable_name, nullptr, 0);
        if (required_length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                failure_context);
        }

        std::vector<wchar_t> value(required_length);
        if (GetEnvironmentVariableW(variable_name, value.data(), required_length) == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                failure_context);
        }
        return std::filesystem::path(value.data());
    }

    std::filesystem::path resolve_known_folder_path(
        REFKNOWNFOLDERID folder_id,
        const wchar_t* failure_context)
    {
        PWSTR value = nullptr;
        const HRESULT result = SHGetKnownFolderPath(
            folder_id,
            KF_FLAG_DEFAULT,
            nullptr,
            &value);
        if (FAILED(result) || value == nullptr)
        {
            CoTaskMemFree(value);
            throw hresult_error(FAILED(result) ? result : E_UNEXPECTED, failure_context);
        }
        const std::filesystem::path path(value);
        CoTaskMemFree(value);
        return path;
    }

    std::wstring normalize_absolute_path(const std::filesystem::path& path)
    {
        const DWORD required_length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
        if (required_length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize a process path");
        }

        std::vector<wchar_t> value(required_length);
        if (GetFullPathNameW(
                path.c_str(),
                required_length,
                value.data(),
                nullptr) == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize a process path");
        }

        std::wstring normalized(value.data());
        std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
        while (normalized.size() > 3 && normalized.back() == L'\\')
        {
            normalized.pop_back();
        }
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](wchar_t character)
        {
            return static_cast<wchar_t>(std::towlower(character));
        });
        return normalized;
    }

    bool is_path_within_directory(
        const std::filesystem::path& candidate_path,
        const std::filesystem::path& directory_path)
    {
        const std::wstring candidate = normalize_absolute_path(candidate_path);
        const std::wstring directory = normalize_absolute_path(directory_path);
        return candidate.size() > directory.size() &&
            candidate.compare(0, directory.size(), directory) == 0 &&
            candidate[directory.size()] == L'\\';
    }

    bool paths_overlap(
        const std::filesystem::path& first_path,
        const std::filesystem::path& second_path)
    {
        return normalize_absolute_path(first_path) == normalize_absolute_path(second_path) ||
            is_path_within_directory(first_path, second_path) ||
            is_path_within_directory(second_path, first_path);
    }

    bool is_windows_apps_path(const std::filesystem::path& candidate_path)
    {
        const DWORD required_length = GetEnvironmentVariableW(L"ProgramFiles", nullptr, 0);
        if (required_length == 0)
        {
            return false;
        }

        std::vector<wchar_t> program_files(required_length);
        if (GetEnvironmentVariableW(
                L"ProgramFiles",
                program_files.data(),
                required_length) == 0)
        {
            return false;
        }
        return is_path_within_directory(
            candidate_path,
            std::filesystem::path(program_files.data()) / L"WindowsApps");
    }

    bool current_process_has_package_identity()
    {
        UINT32 length = 0;
        const LONG result = GetCurrentPackageFullName(&length, nullptr);
        if (result == ERROR_INSUFFICIENT_BUFFER)
        {
            return true;
        }
        if (result == APPMODEL_ERROR_NO_PACKAGE)
        {
            return false;
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(result),
            L"Unable to determine the current package identity");
    }

    std::filesystem::path current_executable_path()
    {
        std::vector<wchar_t> value(32768);
        const DWORD length = GetModuleFileNameW(
            nullptr,
            value.data(),
            static_cast<DWORD>(value.size()));
        if (length == 0 || length >= value.size())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve the Store update helper path");
        }
        return std::filesystem::path(std::wstring(value.data(), length));
    }

    constexpr wchar_t legacy_uninstall_key[] =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
        L"886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
    constexpr wchar_t legacy_installer_key[] =
        L"Software\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4";

    std::string registry_target(
        const wchar_t* key_path,
        const wchar_t* value_name = nullptr)
    {
        std::string target = "HKCU\\" + utf8(key_path);
        if (value_name != nullptr)
        {
            target += "\\" + utf8(value_name);
        }
        return target;
    }

    void probe_legacy_registry_view(
        const wchar_t* key_path,
        const wchar_t* value_name,
        REGSAM view_access,
        const std::string& view_name) noexcept
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_QUERY_VALUE | view_access,
            &key);
        const std::string target = registry_target(key_path, value_name);
        if (open_result != ERROR_SUCCESS)
        {
            append_legacy_cleanup_diagnostic(
                "authority-registry",
                open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "missing"
                    : "error",
                "registry-view-open",
                target,
                static_cast<DWORD>(open_result),
                HRESULT_FROM_WIN32(open_result),
                "view=" + view_name);
            return;
        }

        DWORD value_type = 0;
        DWORD value_bytes = 0;
        const LSTATUS query_result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &value_type,
            nullptr,
            &value_bytes);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            query_result == ERROR_SUCCESS
                ? "present"
                : (query_result == ERROR_FILE_NOT_FOUND ? "value-missing" : "error"),
            "registry-view-query",
            target,
            static_cast<DWORD>(query_result),
            HRESULT_FROM_WIN32(query_result),
            "view=" + view_name +
                "; type=" + std::to_string(value_type) +
                "; bytes=" + std::to_string(value_bytes));
    }

    std::optional<std::wstring> read_current_user_registry_string(
        const wchar_t* key_path,
        const wchar_t* value_name,
        REGSAM view_access,
        const std::string& view_name)
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_QUERY_VALUE | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "missing"
                    : "error"),
            "registry-open",
            registry_target(key_path, value_name),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=" + view_name + "; access=KEY_QUERY_VALUE");
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (open_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                L"Unable to read the legacy Memmy installation authority");
        }

        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &type,
            nullptr,
            &bytes);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            result == ERROR_SUCCESS
                ? "queried-size"
                : (result == ERROR_FILE_NOT_FOUND ? "value-missing" : "error"),
            "registry-query-size",
            registry_target(key_path, value_name),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            "view=" + view_name + "; type=" + std::to_string(type) +
                "; bytes=" + std::to_string(bytes));
        if (result == ERROR_FILE_NOT_FOUND)
        {
            RegCloseKey(key);
            return std::nullopt;
        }
        if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ))
        {
            RegCloseKey(key);
            throw hresult_error(
                result == ERROR_SUCCESS ? E_INVALIDARG : HRESULT_FROM_WIN32(result),
                L"Legacy Memmy installation authority contains an invalid registry value");
        }
        std::vector<wchar_t> value((bytes / sizeof(wchar_t)) + 1, L'\0');
        result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            result == ERROR_SUCCESS ? "read" : "error",
            "registry-query-value",
            registry_target(key_path, value_name),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            result == ERROR_SUCCESS
                ? "view=" + view_name + "; value=" + utf8(value.data())
                : "view=" + view_name);
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the legacy Memmy installation authority value");
        }
        return std::wstring(value.data());
    }

    bool path_is_missing(const std::filesystem::path& path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES)
        {
            return false;
        }
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
        {
            return true;
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(error),
            L"Unable to inspect the legacy Memmy installation path");
    }

    bool validate_legacy_install_authority(
        const std::filesystem::path& legacy_install_directory,
        const std::filesystem::path& legacy_executable_path)
    {
        probe_legacy_registry_view(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        probe_legacy_registry_view(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        probe_legacy_registry_view(
            legacy_uninstall_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        probe_legacy_registry_view(
            legacy_uninstall_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        if (!legacy_install_directory.is_absolute() ||
            !legacy_executable_path.is_absolute() ||
            normalize_absolute_path(legacy_executable_path.parent_path()) !=
                normalize_absolute_path(legacy_install_directory) ||
            _wcsicmp(legacy_executable_path.filename().c_str(), L"Memmy.exe") != 0 ||
            normalize_absolute_path(legacy_install_directory) ==
                normalize_absolute_path(legacy_install_directory.root_path()) ||
            is_windows_apps_path(legacy_install_directory) ||
            is_windows_apps_path(legacy_executable_path))
        {
            throw hresult_invalid_argument(
                L"Refusing an unsafe legacy Memmy installation authority");
        }

        const std::filesystem::path store_control_directory =
            resolve_known_folder_path(
                FOLDERID_LocalAppData,
                L"The current user's Local AppData directory is unavailable for legacy cleanup") /
            L"Memmy";
        if (paths_overlap(legacy_install_directory, store_control_directory))
        {
            throw hresult_invalid_argument(
                L"Refusing a legacy Memmy install path that overlaps the Store transition control directory");
        }

        const auto recorded_install_directory_32 = read_current_user_registry_string(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        const auto recorded_install_directory_64 = read_current_user_registry_string(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        const bool install_missing = path_is_missing(legacy_install_directory);
        if (!recorded_install_directory_32 && !recorded_install_directory_64)
        {
            if (install_missing)
            {
                return false;
            }
            throw hresult_invalid_argument(
                L"Legacy Memmy install directory has no matching uninstall authority");
        }
        const std::wstring normalized_install_directory =
            normalize_absolute_path(legacy_install_directory);
        const auto authority_matches = [&](const std::optional<std::wstring>& recorded)
        {
            return !recorded || normalize_absolute_path(*recorded) == normalized_install_directory;
        };
        if (!authority_matches(recorded_install_directory_32) ||
            !authority_matches(recorded_install_directory_64))
        {
            throw hresult_invalid_argument(
                L"Legacy Memmy install directory does not match the uninstall authority");
        }
        if (install_missing)
        {
            return false;
        }

        const DWORD directory_attributes = GetFileAttributesW(legacy_install_directory.c_str());
        const DWORD executable_attributes = GetFileAttributesW(legacy_executable_path.c_str());
        if ((directory_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (directory_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
            executable_attributes == INVALID_FILE_ATTRIBUTES ||
            (executable_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            throw hresult_invalid_argument(
                L"Legacy Memmy installation authority is not a regular directory and executable");
        }
        return true;
    }

    ULONGLONG query_process_creation_time(HANDLE process)
    {
        FILETIME creation{};
        FILETIME exit{};
        FILETIME kernel{};
        FILETIME user{};
        if (!GetProcessTimes(process, &creation, &exit, &kernel, &user))
        {
            return 0;
        }
        ULARGE_INTEGER value{};
        value.LowPart = creation.dwLowDateTime;
        value.HighPart = creation.dwHighDateTime;
        return value.QuadPart;
    }

    ULONGLONG query_process_creation_time(DWORD process_id)
    {
        const HANDLE process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id);
        if (!process)
        {
            return 0;
        }
        const ULONGLONG result = query_process_creation_time(process);
        CloseHandle(process);
        return result;
    }

    std::vector<ProcessSnapshotEntry> snapshot_processes()
    {
        const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to enumerate processes for legacy takeover");
        }
        std::vector<ProcessSnapshotEntry> processes;
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        if (!Process32FirstW(snapshot, &entry))
        {
            const DWORD error = GetLastError();
            CloseHandle(snapshot);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to read the process snapshot for legacy takeover");
        }
        do
        {
            processes.push_back({
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                query_process_creation_time(entry.th32ProcessID), {}, false, entry.szExeFile
            });
        } while (Process32NextW(snapshot, &entry));
        CloseHandle(snapshot);
        return processes;
    }

    bool try_query_process_image_path(
        HANDLE process,
        std::filesystem::path& image_path)
    {
        std::vector<wchar_t> value(32768);
        DWORD length = static_cast<DWORD>(value.size());
        const BOOL result = QueryFullProcessImageNameW(
            process,
            0,
            value.data(),
            &length);
        if (!result || length == 0)
        {
            return false;
        }
        image_path = std::filesystem::path(std::wstring(value.data(), length));
        return true;
    }

    bool try_query_process_image_path(
        DWORD process_id,
        std::filesystem::path& image_path)
    {
        const HANDLE process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id);
        if (!process)
        {
            return false;
        }
        const bool result = try_query_process_image_path(process, image_path);
        CloseHandle(process);
        return result;
    }

    std::vector<ProcessSnapshotEntry> find_legacy_process_tree(
        const std::filesystem::path& legacy_install_directory)
    {
        std::vector<ProcessSnapshotEntry> processes = snapshot_processes();
        std::unordered_set<DWORD> target_process_ids;
        const DWORD current_process_id = GetCurrentProcessId();
        for (auto& process : processes)
        {
            if (process.process_id == 0 ||
                process.process_id == current_process_id ||
                process.creation_time == 0)
            {
                continue;
            }
            process.image_path_verified =
                try_query_process_image_path(process.process_id, process.image_path);
            if (process.image_path_verified &&
                !is_windows_apps_path(process.image_path) &&
                is_path_within_directory(process.image_path, legacy_install_directory))
            {
                target_process_ids.insert(process.process_id);
            }
        }

        std::unordered_map<DWORD, ProcessSnapshotEntry> processes_by_id;
        for (const auto& process : processes)
        {
            processes_by_id.emplace(process.process_id, process);
        }
        bool added_descendant = true;
        while (added_descendant)
        {
            added_descendant = false;
            for (const auto& process : processes)
            {
                if (target_process_ids.contains(process.process_id) ||
                    !target_process_ids.contains(process.parent_process_id))
                {
                    continue;
                }
                const auto parent = processes_by_id.find(process.parent_process_id);
                if (parent == processes_by_id.end() ||
                    process.creation_time == 0 ||
                    parent->second.creation_time == 0 ||
                    process.creation_time < parent->second.creation_time ||
                    !process.image_path_verified ||
                    is_windows_apps_path(process.image_path) ||
                    !is_path_within_directory(process.image_path, legacy_install_directory))
                {
                    continue;
                }
                target_process_ids.insert(process.process_id);
                added_descendant = true;
            }
        }

        std::unordered_map<DWORD, DWORD> parent_process_ids;
        for (const auto& process : processes)
        {
            parent_process_ids.emplace(process.process_id, process.parent_process_id);
        }
        const auto process_depth = [&parent_process_ids, &target_process_ids](DWORD process_id)
        {
            size_t depth = 0;
            std::unordered_set<DWORD> visited;
            auto current = process_id;
            while (visited.insert(current).second)
            {
                const auto parent = parent_process_ids.find(current);
                if (parent == parent_process_ids.end() ||
                    !target_process_ids.contains(parent->second))
                {
                    break;
                }
                ++depth;
                current = parent->second;
            }
            return depth;
        };

        std::vector<ProcessSnapshotEntry> targets;
        std::copy_if(
            processes.begin(),
            processes.end(),
            std::back_inserter(targets),
            [&target_process_ids](const ProcessSnapshotEntry& process)
            {
                return target_process_ids.contains(process.process_id);
            });
        std::sort(targets.begin(), targets.end(), [&process_depth](
            const ProcessSnapshotEntry& left,
            const ProcessSnapshotEntry& right)
        {
            return process_depth(left.process_id) > process_depth(right.process_id);
        });
        return targets;
    }

    BOOL CALLBACK close_legacy_window(HWND window, LPARAM parameter)
    {
        const auto* targets = reinterpret_cast<const std::vector<ProcessSnapshotEntry>*>(parameter);
        DWORD process_id = 0;
        GetWindowThreadProcessId(window, &process_id);
        const auto target = std::find_if(targets->begin(), targets->end(), [process_id](const ProcessSnapshotEntry& entry) {
            return entry.process_id == process_id;
        });
        if (target == targets->end())
        {
            return TRUE;
        }
        const HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
        if (!process) return TRUE;
        if (target->creation_time == 0 || query_process_creation_time(process) != target->creation_time ||
            WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
        {
            CloseHandle(process);
            return TRUE;
        }
        // Let the shared wait below bound shutdown for all windows together.
        PostMessageW(window, WM_CLOSE, 0, 0);
        CloseHandle(process);
        return TRUE;
    }

    void request_graceful_legacy_exit(
        const std::vector<ProcessSnapshotEntry>& targets)
    {
        EnumWindows(
            close_legacy_window,
            reinterpret_cast<LPARAM>(&targets));
    }

    bool wait_for_process_snapshot_to_exit(
        const std::vector<ProcessSnapshotEntry>& targets,
        DWORD timeout_ms)
    {
        const ULONGLONG deadline = GetTickCount64() + timeout_ms;
        do
        {
            bool any_running = false;
            for (const auto& target : targets)
            {
                const HANDLE process = OpenProcess(
                    SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    FALSE,
                    target.process_id);
                if (!process)
                {
                    if (GetLastError() != ERROR_INVALID_PARAMETER) return false;
                    continue;
                }
                any_running =
                    target.creation_time != 0 &&
                    query_process_creation_time(process) == target.creation_time &&
                    WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
                CloseHandle(process);
                if (any_running)
                {
                    break;
                }
            }
            if (!any_running)
            {
                return true;
            }
            Sleep(100);
        } while (GetTickCount64() < deadline);
        return false;
    }

    void terminate_legacy_process_tree(
        const std::vector<ProcessSnapshotEntry>& targets,
        ULONGLONG deadline = 0)
    {
        for (const auto& target : targets)
        {
            if (deadline && GetTickCount64() >= deadline)
                throw hresult_error(HRESULT_FROM_WIN32(ERROR_TIMEOUT), L"Legacy shutdown deadline reached");
            const HANDLE process = OpenProcess(
                PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                FALSE,
                target.process_id);
            if (!process)
            {
                const DWORD error = GetLastError();
                if (error == ERROR_INVALID_PARAMETER)
                {
                    continue;
                }
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to open a validated legacy Memmy process");
            }
            if (target.creation_time == 0 ||
                query_process_creation_time(process) != target.creation_time ||
                WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
            {
                CloseHandle(process);
                continue;
            }
            std::filesystem::path current_image_path;
            if (!try_query_process_image_path(process, current_image_path))
            {
                const DWORD error = GetLastError();
                if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) { CloseHandle(process); continue; }
                CloseHandle(process);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error == ERROR_SUCCESS ? ERROR_ACCESS_DENIED : error),
                    L"Unable to revalidate a legacy Memmy process image path");
            }
            if (!target.image_path_verified ||
                is_windows_apps_path(current_image_path) ||
                normalize_absolute_path(current_image_path) !=
                    normalize_absolute_path(target.image_path))
            {
                CloseHandle(process);
                continue;
            }
            if (!TerminateProcess(process, 0))
            {
                const DWORD error = GetLastError();
                if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) { CloseHandle(process); continue; }
                CloseHandle(process);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to terminate a validated legacy Memmy process");
            }
            const auto current = GetTickCount64();
            const auto remaining = deadline ? (deadline > current ? deadline - current : 0) : 3000;
            const DWORD wait_result = WaitForSingleObject(process, static_cast<DWORD>((std::min)(remaining, 3000ULL)));
            CloseHandle(process);
            if (wait_result != WAIT_OBJECT_0) throw hresult_error(HRESULT_FROM_WIN32(ERROR_BUSY), L"Legacy process did not exit");
        }
    }

    void stop_legacy_processes(const std::filesystem::path& legacy_install_directory)
    {
        constexpr int maximum_scan_rounds = 8;
        constexpr int required_empty_rounds = 3;
        int empty_rounds = 0;
        for (int round = 0; round < maximum_scan_rounds; ++round)
        {
            const auto targets = find_legacy_process_tree(legacy_install_directory);
            if (targets.empty())
            {
                ++empty_rounds;
                if (empty_rounds >= required_empty_rounds)
                {
                    return;
                }
                Sleep(150);
                continue;
            }
            empty_rounds = 0;
            request_graceful_legacy_exit(targets);
            if (!wait_for_process_snapshot_to_exit(targets, 2000))
            {
                terminate_legacy_process_tree(targets);
                wait_for_process_snapshot_to_exit(targets, 1000);
            }
        }
        if (!find_legacy_process_tree(legacy_install_directory).empty())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_BUSY),
                L"Legacy Memmy processes restarted during Store takeover");
        }
    }

    void prepare_legacy_takeover(const LegacyTransitionOptions& options)
    {
        if (!validate_legacy_install_authority(
                options.legacy_install_directory,
                options.legacy_executable_path))
        {
            return;
        }
        stop_legacy_processes(options.legacy_install_directory);
    }

    std::wstring quote_command_line_argument(const std::wstring& value)
    {
        if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos)
        {
            return value;
        }

        std::wstring quoted(1, L'\"');
        size_t backslash_count = 0;
        for (const wchar_t character : value)
        {
            if (character == L'\\')
            {
                ++backslash_count;
                continue;
            }
            if (character == L'\"')
            {
                quoted.append(backslash_count * 2 + 1, L'\\');
                quoted.push_back(character);
                backslash_count = 0;
                continue;
            }
            quoted.append(backslash_count, L'\\');
            backslash_count = 0;
            quoted.push_back(character);
        }
        quoted.append(backslash_count * 2, L'\\');
        quoted.push_back(L'\"');
        return quoted;
    }

    DeleteTreeResult delete_tree_failure(
        DWORD win32_error,
        const std::filesystem::path& failed_path,
        const std::string& operation)
    {
        return { win32_error, failed_path, operation };
    }

    DeleteTreeResult delete_directory_tree_once(const std::filesystem::path& path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                ? DeleteTreeResult{}
                : delete_tree_failure(error, path, "GetFileAttributesW");
        }
        if ((attributes & FILE_ATTRIBUTE_READONLY) != 0 &&
            !SetFileAttributesW(path.c_str(), attributes & ~FILE_ATTRIBUTE_READONLY))
        {
            const DWORD error = GetLastError();
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                "attribute-clear-error-ignored",
                "SetFileAttributesW",
                utf8(path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
        }
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
        {
            if (DeleteFileW(path.c_str()))
            {
                return {};
            }
            return delete_tree_failure(GetLastError(), path, "DeleteFileW");
        }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            if (RemoveDirectoryW(path.c_str()))
            {
                return {};
            }
            return delete_tree_failure(GetLastError(), path, "RemoveDirectoryW(reparse-point)");
        }

        WIN32_FIND_DATAW entry{};
        HANDLE search = FindFirstFileW((path / L"*").c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE)
        {
            const DWORD error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND)
            {
                return delete_tree_failure(error, path, "FindFirstFileW");
            }
            if (RemoveDirectoryW(path.c_str()))
            {
                return {};
            }
            const DWORD remove_error = GetLastError();
            return remove_error == ERROR_FILE_NOT_FOUND || remove_error == ERROR_PATH_NOT_FOUND
                ? DeleteTreeResult{}
                : delete_tree_failure(remove_error, path, "RemoveDirectoryW(empty-directory)");
        }
        DeleteTreeResult result;
        do
        {
            if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0)
            {
                continue;
            }
            result = delete_directory_tree_once(path / entry.cFileName);
            if (result.win32_error != ERROR_SUCCESS)
            {
                break;
            }
        } while (FindNextFileW(search, &entry));
        if (result.win32_error == ERROR_SUCCESS)
        {
            const DWORD enumeration_error = GetLastError();
            if (enumeration_error != ERROR_NO_MORE_FILES)
            {
                result = delete_tree_failure(enumeration_error, path, "FindNextFileW");
            }
        }
        FindClose(search);
        if (result.win32_error != ERROR_SUCCESS)
        {
            return result;
        }
        if (RemoveDirectoryW(path.c_str()))
        {
            return {};
        }
        return delete_tree_failure(GetLastError(), path, "RemoveDirectoryW");
    }

    void remove_legacy_install_directory(const LegacyTransitionOptions& options)
    {
        DeleteTreeResult result;
        constexpr int maximum_attempts = 20;
        for (int attempt = 0; attempt < maximum_attempts; ++attempt)
        {
            if (attempt > 0)
            {
                // Files may already be partially removed, including Memmy.exe. The
                // authority was validated before deletion began, so retries must not
                // require the executable to remain present.
                stop_legacy_processes(options.legacy_install_directory);
            }
            result = delete_directory_tree_once(options.legacy_install_directory);
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                result.win32_error == ERROR_SUCCESS ? "success" : "retryable-error",
                result.operation.empty() ? "delete-directory-tree" : result.operation,
                result.failed_path.empty()
                    ? utf8(options.legacy_install_directory.wstring())
                    : utf8(result.failed_path.wstring()),
                result.win32_error,
                HRESULT_FROM_WIN32(result.win32_error),
                "attempt=" + std::to_string(attempt + 1));
            if (result.win32_error == ERROR_SUCCESS)
            {
                return;
            }
            Sleep(250);
        }
        set_legacy_cleanup_failure_context(
            result.operation.empty() ? "delete-directory-tree" : result.operation,
            result.failed_path.empty()
                ? utf8(options.legacy_install_directory.wstring())
                : utf8(result.failed_path.wstring()),
            result.win32_error);
        throw hresult_error(
            HRESULT_FROM_WIN32(result.win32_error),
            to_hstring(
                "Unable to remove the authority-bound legacy Memmy install directory; operation=" +
                result.operation + "; path=" + utf8(result.failed_path.wstring())));
    }

    void delete_registry_tree_if_present(
        const wchar_t* key_path,
        REGSAM view_access,
        const std::string& view_name)
    {
        const std::string event = wcscmp(key_path, legacy_uninstall_key) == 0
            ? "uninstall-registry-delete"
            : "installer-authority-registry-delete";
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            event,
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "RegOpenKeyExW(delete)",
            registry_target(key_path),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=" + view_name);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            set_legacy_cleanup_failure_context(
                "RegOpenKeyExW(delete)",
                registry_target(key_path),
                static_cast<DWORD>(open_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                to_hstring(
                    "Unable to open the legacy registry tree for deletion; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }

        const LSTATUS tree_result = RegDeleteTreeW(key, nullptr);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            event,
            tree_result == ERROR_SUCCESS
                ? "contents-deleted"
                : (tree_result == ERROR_FILE_NOT_FOUND || tree_result == ERROR_PATH_NOT_FOUND
                    ? "contents-already-missing"
                    : "error"),
            "RegDeleteTreeW",
            registry_target(key_path),
            static_cast<DWORD>(tree_result),
            HRESULT_FROM_WIN32(tree_result),
            "view=" + view_name + "; subKey=null");
        if (tree_result != ERROR_SUCCESS &&
            tree_result != ERROR_FILE_NOT_FOUND &&
            tree_result != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "RegDeleteTreeW",
                registry_target(key_path),
                static_cast<DWORD>(tree_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(tree_result),
                to_hstring(
                    "Unable to delete the legacy registry tree contents; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }

        const LSTATUS delete_result = RegDeleteKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            view_access,
            0);
        append_legacy_cleanup_diagnostic(
            event,
            delete_result == ERROR_SUCCESS
                ? "success"
                : (delete_result == ERROR_FILE_NOT_FOUND || delete_result == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "RegDeleteKeyExW",
            registry_target(key_path),
            static_cast<DWORD>(delete_result),
            HRESULT_FROM_WIN32(delete_result),
            "view=" + view_name);
        if (delete_result != ERROR_SUCCESS &&
            delete_result != ERROR_FILE_NOT_FOUND &&
            delete_result != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "RegDeleteKeyExW",
                registry_target(key_path),
                static_cast<DWORD>(delete_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(delete_result),
                to_hstring(
                    "Unable to delete the legacy registry key; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }
    }

    bool registry_tree_exists(
        const wchar_t* key_path,
        REGSAM view_access,
        const std::string& view_name)
    {
        HKEY key = nullptr;
        const LSTATUS result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_READ | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            wcscmp(key_path, legacy_uninstall_key) == 0
                ? "uninstall-registry-delete"
                : "installer-authority-registry-delete",
            result == ERROR_SUCCESS
                ? "still-present"
                : (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND
                    ? "verified-missing"
                    : "verify-error"),
            "RegOpenKeyExW(post-check)",
            registry_target(key_path),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            "view=" + view_name);
        if (result == ERROR_SUCCESS)
        {
            RegCloseKey(key);
            return true;
        }
        if (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND)
        {
            return false;
        }
        set_legacy_cleanup_failure_context(
            "RegOpenKeyExW(post-check)",
            registry_target(key_path),
            static_cast<DWORD>(result));
        throw hresult_error(
            HRESULT_FROM_WIN32(result),
            L"Unable to verify the legacy registry cleanup");
    }

    void delete_registry_value_if_present(const wchar_t* key_path, const wchar_t* value_name)
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_SET_VALUE,
            &key);
        append_legacy_cleanup_diagnostic(
            "run-registry-delete",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "key-missing"
                    : "open-error"),
            "RegOpenKeyExW",
            registry_target(key_path, value_name),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=process-default; access=KEY_SET_VALUE");
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            check_hresult(HRESULT_FROM_WIN32(open_result));
        }
        const LSTATUS delete_result = RegDeleteValueW(key, value_name);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "run-registry-delete",
            delete_result == ERROR_SUCCESS
                ? "success"
                : (delete_result == ERROR_FILE_NOT_FOUND ? "already-missing" : "error"),
            "RegDeleteValueW",
            registry_target(key_path, value_name),
            static_cast<DWORD>(delete_result),
            HRESULT_FROM_WIN32(delete_result),
            "view=process-default");
        if (delete_result != ERROR_SUCCESS && delete_result != ERROR_FILE_NOT_FOUND)
        {
            check_hresult(HRESULT_FROM_WIN32(delete_result));
        }
    }

    std::wstring normalize_path_component(std::wstring value)
    {
        while (!value.empty() && std::iswspace(value.front()))
        {
            value.erase(value.begin());
        }
        while (!value.empty() && std::iswspace(value.back()))
        {
            value.pop_back();
        }
        if (value.size() >= 2 && value.front() == L'\"' && value.back() == L'\"')
        {
            value = value.substr(1, value.size() - 2);
        }
        std::replace(value.begin(), value.end(), L'/', L'\\');
        while (!value.empty() && value.back() == L'\\')
        {
            value.pop_back();
        }
        std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character)
        {
            return static_cast<wchar_t>(std::towlower(character));
        });
        return value;
    }

    void remove_legacy_cli_from_user_path(
        const std::filesystem::path& legacy_install_directory)
    {
        const std::wstring target = normalize_path_component(
            (legacy_install_directory / L"resources" / L"cli").wstring());
        HKEY environment_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            L"Environment",
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &environment_key);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "key-missing"
                    : "open-error"),
            "RegOpenKeyExW",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result));
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            check_hresult(HRESULT_FROM_WIN32(open_result));
        }
        DWORD value_type = 0;
        DWORD value_size = 0;
        LSTATUS read_result = RegQueryValueExW(
            environment_key,
            L"Path",
            nullptr,
            &value_type,
            nullptr,
            &value_size);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            read_result == ERROR_SUCCESS
                ? "queried-size"
                : (read_result == ERROR_FILE_NOT_FOUND ? "value-missing" : "query-error"),
            "RegQueryValueExW(size)",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(read_result),
            HRESULT_FROM_WIN32(read_result),
            "type=" + std::to_string(value_type) + "; bytes=" + std::to_string(value_size));
        if (read_result == ERROR_FILE_NOT_FOUND)
        {
            RegCloseKey(environment_key);
            return;
        }
        if (read_result != ERROR_SUCCESS ||
            (value_type != REG_SZ && value_type != REG_EXPAND_SZ))
        {
            RegCloseKey(environment_key);
            if (read_result != ERROR_SUCCESS)
            {
                check_hresult(HRESULT_FROM_WIN32(read_result));
            }
            return;
        }
        std::vector<wchar_t> buffer((value_size / sizeof(wchar_t)) + 1, L'\0');
        read_result = RegQueryValueExW(
            environment_key,
            L"Path",
            nullptr,
            &value_type,
            reinterpret_cast<BYTE*>(buffer.data()),
            &value_size);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            read_result == ERROR_SUCCESS ? "read" : "query-error",
            "RegQueryValueExW(value)",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(read_result),
            HRESULT_FROM_WIN32(read_result));
        if (read_result != ERROR_SUCCESS)
        {
            RegCloseKey(environment_key);
            check_hresult(HRESULT_FROM_WIN32(read_result));
        }

        const std::wstring original(buffer.data());
        std::wstring filtered;
        size_t start = 0;
        while (start <= original.size())
        {
            const size_t separator = original.find(L';', start);
            const std::wstring component = original.substr(
                start,
                separator == std::wstring::npos ? std::wstring::npos : separator - start);
            if (!component.empty() && normalize_path_component(component) != target)
            {
                if (!filtered.empty())
                {
                    filtered += L';';
                }
                filtered += component;
            }
            if (separator == std::wstring::npos)
            {
                break;
            }
            start = separator + 1;
        }
        if (filtered != original)
        {
            const DWORD bytes = static_cast<DWORD>((filtered.size() + 1) * sizeof(wchar_t));
            const LSTATUS write_result = RegSetValueExW(
                environment_key,
                L"Path",
                0,
                value_type,
                reinterpret_cast<const BYTE*>(filtered.c_str()),
                bytes);
            RegCloseKey(environment_key);
            append_legacy_cleanup_diagnostic(
                "user-path-update",
                write_result == ERROR_SUCCESS ? "success" : "write-error",
                "RegSetValueExW",
                "HKCU\\Environment\\Path",
                static_cast<DWORD>(write_result),
                HRESULT_FROM_WIN32(write_result));
            if (write_result != ERROR_SUCCESS)
            {
                check_hresult(HRESULT_FROM_WIN32(write_result));
            }
            DWORD_PTR ignored = 0;
            const LRESULT broadcast_result = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                reinterpret_cast<LPARAM>(L"Environment"),
                SMTO_ABORTIFHUNG,
                5000,
                &ignored);
            const DWORD broadcast_error = broadcast_result == 0 ? GetLastError() : ERROR_SUCCESS;
            append_legacy_cleanup_diagnostic(
                "user-path-update",
                broadcast_result != 0 ? "broadcast-success" : "broadcast-error-ignored",
                "SendMessageTimeoutW",
                "WM_SETTINGCHANGE:Environment",
                broadcast_error,
                HRESULT_FROM_WIN32(broadcast_error));
            return;
        }
        RegCloseKey(environment_key);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            "unchanged",
            "filter-path",
            utf8((legacy_install_directory / L"resources" / L"cli").wstring()));
    }

    void create_apps_folder_shortcut(
        const std::filesystem::path& shortcut_path,
        const std::wstring& aumid)
    {
        com_ptr<IShellItem> apps_folder;
        const HRESULT apps_folder_result = SHGetKnownFolderItem(
            FOLDERID_AppsFolder,
            KF_FLAG_DEFAULT,
            nullptr,
            IID_PPV_ARGS(apps_folder.put()));
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(apps_folder_result) ? "success" : "error",
            "SHGetKnownFolderItem",
            "AppsFolder",
            std::nullopt,
            apps_folder_result);
        if (FAILED(apps_folder_result))
        {
            set_legacy_cleanup_failure_context("SHGetKnownFolderItem", "AppsFolder");
        }
        check_hresult(apps_folder_result);
        com_ptr<IShellItem> application_item;
        const HRESULT application_item_result = SHCreateItemFromRelativeName(
            apps_folder.get(),
            aumid.c_str(),
            nullptr,
            IID_PPV_ARGS(application_item.put()));
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(application_item_result) ? "success" : "error",
            "SHCreateItemFromRelativeName",
            utf8(aumid),
            std::nullopt,
            application_item_result);
        if (FAILED(application_item_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateItemFromRelativeName",
                utf8(aumid));
        }
        check_hresult(application_item_result);
        PIDLIST_ABSOLUTE full_item_id = nullptr;
        const HRESULT item_id_result = SHGetIDListFromObject(application_item.get(), &full_item_id);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(item_id_result) ? "success" : "error",
            "SHGetIDListFromObject",
            utf8(aumid),
            std::nullopt,
            item_id_result);
        if (FAILED(item_id_result))
        {
            set_legacy_cleanup_failure_context(
                "SHGetIDListFromObject",
                utf8(aumid));
        }
        check_hresult(item_id_result);
        if (full_item_id == nullptr)
        {
            set_legacy_cleanup_failure_context(
                "SHGetIDListFromObject",
                utf8(aumid));
            throw hresult_error(
                E_UNEXPECTED,
                L"Windows returned an empty AppsFolder item identifier");
        }
        const PCUITEMID_CHILD child_item = ILFindLastID(full_item_id);
        PIDLIST_ABSOLUTE parent_item_id =
            reinterpret_cast<PIDLIST_ABSOLUTE>(ILClone(full_item_id));
        if (!parent_item_id)
        {
            CoTaskMemFree(full_item_id);
            throw hresult_error(E_OUTOFMEMORY, L"Unable to clone the AppsFolder item identifier");
        }
        if (!ILRemoveLastID(parent_item_id))
        {
            CoTaskMemFree(parent_item_id);
            CoTaskMemFree(full_item_id);
            throw hresult_error(E_FAIL, L"Unable to resolve the AppsFolder item parent");
        }
        com_ptr<IDataObject> data_object;
        PCUITEMID_CHILD children[] = { child_item };
        const HRESULT data_result = SHCreateDataObject(
            parent_item_id,
            1,
            children,
            nullptr,
            IID_PPV_ARGS(data_object.put()));
        CoTaskMemFree(parent_item_id);
        CoTaskMemFree(full_item_id);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(data_result) ? "success" : "error",
            "SHCreateDataObject",
            utf8(aumid),
            std::nullopt,
            data_result);
        if (FAILED(data_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateDataObject",
                utf8(aumid));
        }
        check_hresult(data_result);
        using CreateLinksFunction =
            HRESULT(WINAPI*)(HWND, LPCWSTR, IDataObject*, UINT, PIDLIST_ABSOLUTE*);
        const HMODULE shell_module = GetModuleHandleW(L"shell32.dll");
        const auto create_links = shell_module
            ? reinterpret_cast<CreateLinksFunction>(
                GetProcAddress(shell_module, MAKEINTRESOURCEA(172)))
            : nullptr;
        if (!create_links)
        {
            set_legacy_cleanup_failure_context(
                "GetProcAddress(SHCreateLinks)",
                "shell32.dll ordinal 172",
                ERROR_PROC_NOT_FOUND);
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND),
                L"Windows shell link creation is unavailable");
        }
        std::error_code remove_error;
        std::filesystem::remove(shortcut_path, remove_error);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            remove_error ? "existing-shortcut-remove-error" : "existing-shortcut-removed-or-missing",
            "std::filesystem::remove",
            utf8(shortcut_path.wstring()),
            remove_error ? std::optional<DWORD>(static_cast<DWORD>(remove_error.value())) : std::nullopt,
            remove_error
                ? std::optional<HRESULT>(HRESULT_FROM_WIN32(remove_error.value()))
                : std::nullopt);
        if (remove_error)
        {
            const DWORD error = static_cast<DWORD>(remove_error.value());
            set_legacy_cleanup_failure_context(
                "std::filesystem::remove",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to remove the existing Memmy desktop shortcut");
        }
        PIDLIST_ABSOLUTE created_item_id = nullptr;
        const HRESULT link_result = create_links(
            nullptr,
            shortcut_path.parent_path().c_str(),
            data_object.get(),
            0,
            &created_item_id);
        std::wstring created_shortcut_path;
        HRESULT created_path_result = E_FAIL;
        const bool created_item_id_present = created_item_id != nullptr;
        if (created_item_id_present)
        {
            PWSTR created_path = nullptr;
            created_path_result = SHGetNameFromIDList(
                created_item_id,
                SIGDN_FILESYSPATH,
                &created_path);
            if (SUCCEEDED(created_path_result) && created_path)
            {
                created_shortcut_path = created_path;
            }
            CoTaskMemFree(created_path);
            CoTaskMemFree(created_item_id);
        }
        const bool created_path_available =
            SUCCEEDED(created_path_result) && !created_shortcut_path.empty();
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            created_path_available ? "path-resolved" : "path-resolution-unavailable",
            "SHGetNameFromIDList",
            created_path_available
                ? utf8(created_shortcut_path)
                : utf8(shortcut_path.wstring()),
            std::nullopt,
            created_path_result,
            std::string("createdItemIdPresent=") +
                (created_item_id_present ? "true" : "false") +
                "; advisoryOnly=true; exactExpectedPathVerificationRequired=true");
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(link_result) ? "success" : "error",
            "SHCreateLinks",
            utf8(shortcut_path.wstring()),
            std::nullopt,
            link_result);
        if (FAILED(link_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateLinks",
                utf8(shortcut_path.wstring()));
        }
        check_hresult(link_result);
        if (!created_shortcut_path.empty() &&
            normalize_absolute_path(created_shortcut_path) !=
            normalize_absolute_path(shortcut_path))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateLinks(created-path-check)",
                utf8(created_shortcut_path));
            throw hresult_error(
                E_FAIL,
                L"Windows created the Memmy desktop shortcut at an unexpected path");
        }
        std::error_code shortcut_exists_error;
        const bool shortcut_exists = std::filesystem::exists(
            shortcut_path,
            shortcut_exists_error);
        if (shortcut_exists_error)
        {
            const DWORD error = static_cast<DWORD>(shortcut_exists_error.value());
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-error",
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
            set_legacy_cleanup_failure_context(
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to inspect the expected Memmy desktop shortcut");
        }
        if (!shortcut_exists)
        {
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-missing",
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                std::nullopt,
                E_FAIL);
            throw hresult_error(E_FAIL, L"Windows did not create the expected Memmy desktop shortcut");
        }
        const DWORD shortcut_attributes = GetFileAttributesW(shortcut_path.c_str());
        if (shortcut_attributes == INVALID_FILE_ATTRIBUTES ||
            (shortcut_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            const DWORD error = shortcut_attributes == INVALID_FILE_ATTRIBUTES
                ? GetLastError()
                : ERROR_INVALID_DATA;
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-not-regular-file",
                "GetFileAttributesW",
                utf8(shortcut_path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"The created Memmy desktop shortcut is not a regular file");
        }
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            "verified-created-path",
            "std::filesystem::exists",
            utf8(shortcut_path.wstring()),
            std::nullopt,
            std::nullopt,
            "createdPath=" +
                (created_shortcut_path.empty()
                    ? std::string("<unavailable>")
                    : utf8(created_shortcut_path)) +
                "; pathResolutionHresult=" + hresult_text(created_path_result) +
                "; verifiedBy=exact-expected-path");
    }

    std::string utf8(const std::wstring& value)
    {
        return to_string(hstring(value));
    }

    std::string utc_timestamp()
    {
        SYSTEMTIME value{};
        GetSystemTime(&value);
        char buffer[32]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
            value.wYear,
            value.wMonth,
            value.wDay,
            value.wHour,
            value.wMinute,
            value.wSecond,
            value.wMilliseconds);
        return buffer;
    }

    std::string hresult_text(HRESULT value)
    {
        std::ostringstream output;
        output << "0x"
               << std::uppercase
               << std::hex
               << std::setw(8)
               << std::setfill('0')
               << static_cast<uint32_t>(value);
        return output.str();
    }

    std::optional<DWORD> win32_error_from_hresult(HRESULT value) noexcept
    {
        if (HRESULT_FACILITY(value) != FACILITY_WIN32)
        {
            return std::nullopt;
        }
        return static_cast<DWORD>(HRESULT_CODE(value));
    }

    std::string single_line(std::string value)
    {
        std::replace(value.begin(), value.end(), '\r', ' ');
        std::replace(value.begin(), value.end(), '\n', ' ');
        return value;
    }

    bool append_legacy_cleanup_diagnostic(
        const std::string& event,
        const std::string& outcome,
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error,
        std::optional<HRESULT> hresult,
        const std::string& detail) noexcept
    {
        try
        {
            if (!legacy_cleanup_diagnostics)
            {
                return false;
            }
            const auto& diagnostics = *legacy_cleanup_diagnostics;
            const DWORD log_attributes = GetFileAttributesW(diagnostics.log_path.c_str());
            if (log_attributes != INVALID_FILE_ATTRIBUTES &&
                ((log_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
                    (log_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0))
            {
                return false;
            }
            if (log_attributes == INVALID_FILE_ATTRIBUTES)
            {
                const DWORD inspect_error = GetLastError();
                if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
                {
                    return false;
                }
            }
            std::ofstream output(diagnostics.log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return false;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"processRole\":\"" << escape_json(diagnostics.process_role) << "\""
                   << ",\"transitionId\":\"" << escape_json(diagnostics.transition_id) << "\""
                   << ",\"attemptId\":\"" << escape_json(diagnostics.attempt_id) << "\""
                   << ",\"pid\":" << diagnostics.process_id;
            if (diagnostics.session_id_available)
            {
                output << ",\"sessionId\":" << diagnostics.session_id;
            }
            else
            {
                output << ",\"sessionId\":null";
            }
            output << ",\"hasPackageIdentity\":"
                   << (diagnostics.has_package_identity ? "true" : "false")
                   << ",\"packageIdentityWin32\":" << diagnostics.package_identity_result;
            if (!diagnostics.package_full_name.empty())
            {
                output << ",\"packageFullName\":\""
                       << escape_json(diagnostics.package_full_name) << "\"";
            }
            output << ",\"event\":\"" << escape_json(event) << "\"";
            if (!outcome.empty())
            {
                output << ",\"outcome\":\"" << escape_json(outcome) << "\"";
            }
            if (!operation.empty())
            {
                output << ",\"operation\":\"" << escape_json(operation) << "\"";
            }
            if (!target.empty())
            {
                output << ",\"target\":\"" << escape_json(target) << "\"";
            }
            if (win32_error)
            {
                output << ",\"win32Error\":" << *win32_error;
            }
            if (hresult)
            {
                output << ",\"hresult\":\"" << hresult_text(*hresult) << "\""
                       << ",\"hresultSigned\":" << static_cast<int32_t>(*hresult);
            }
            if (!detail.empty())
            {
                output << ",\"detail\":\"" << escape_json(single_line(detail)) << "\"";
            }
            output << "}\n";
            output.flush();
            return static_cast<bool>(output);
        }
        catch (...)
        {
            return false;
        }
    }

    void begin_legacy_cleanup_operation(
        const std::string& operation,
        const std::string& target) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        legacy_cleanup_diagnostics->current_operation = operation;
        legacy_cleanup_diagnostics->current_target = target;
        legacy_cleanup_diagnostics->current_win32_error.reset();
        append_legacy_cleanup_diagnostic(
            operation,
            "started",
            operation,
            target);
    }

    void complete_legacy_cleanup_operation(const std::string& detail) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        const std::string operation = legacy_cleanup_diagnostics->current_operation;
        const std::string target = legacy_cleanup_diagnostics->current_target;
        append_legacy_cleanup_diagnostic(
            operation,
            "success",
            operation,
            target,
            std::nullopt,
            std::nullopt,
            detail);
        legacy_cleanup_diagnostics->current_operation.clear();
        legacy_cleanup_diagnostics->current_target.clear();
        legacy_cleanup_diagnostics->current_win32_error.reset();
    }

    void set_legacy_cleanup_failure_context(
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        legacy_cleanup_diagnostics->current_operation = operation;
        legacy_cleanup_diagnostics->current_target = target;
        legacy_cleanup_diagnostics->current_win32_error = win32_error;
    }

    void write_text_file_atomic(
        const std::filesystem::path& target_path,
        const std::string& contents)
    {
        std::filesystem::create_directories(target_path.parent_path());
        const std::filesystem::path temporary_path =
            target_path.wstring() +
            L"." +
            std::to_wstring(GetCurrentProcessId()) +
            L".tmp";
        {
            std::ofstream output(temporary_path, std::ios::binary | std::ios::trunc);
            if (!output)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                    L"Unable to create the Store update handoff file");
            }
            output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
            output.flush();
            if (!output)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                    L"Unable to write the Store update handoff file");
            }
        }
        if (!MoveFileExW(
                temporary_path.c_str(),
                target_path.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            const DWORD error = GetLastError();
            DeleteFileW(temporary_path.c_str());
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to commit the Store update handoff file");
        }
    }

    void append_handoff_log(
        const std::filesystem::path& log_path,
        const std::string& event,
        const std::string& state = "",
        const std::string& hresult = "",
        const std::string& reason = "") noexcept
    {
        try
        {
            std::filesystem::create_directories(log_path.parent_path());
            std::ofstream output(log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"event\":\"" << escape_json(event) << "\"";
            if (!state.empty())
            {
                output << ",\"state\":\"" << escape_json(state) << "\"";
            }
            if (!hresult.empty())
            {
                output << ",\"hresult\":\"" << escape_json(hresult) << "\"";
            }
            if (!reason.empty())
            {
                output << ",\"reason\":\"" << escape_json(single_line(reason)) << "\"";
            }
            output << "}\n";
        }
        catch (...)
        {
        }
    }

    void write_store_install_result(
        const StoreInstallHandoffOptions& options,
        const std::string& state,
        const std::string& hresult,
        const std::string& reason)
    {
        write_text_file_atomic(
            options.result_path,
            single_line(state) + "\n" +
                single_line(hresult) + "\n" +
                single_line(reason) + "\n");
        append_handoff_log(options.log_path, "installer-result", state, hresult, reason);
    }

    void append_store_package_log(
        const std::filesystem::path& log_path,
        const std::string& event,
        const StorePackageUpdateStatus& status) noexcept
    {
        try
        {
            std::filesystem::create_directories(log_path.parent_path());
            std::ofstream output(log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"event\":\"" << escape_json(event) << "\""
                   << ",\"packageFamilyName\":\""
                   << escape_json(to_string(status.PackageFamilyName)) << "\""
                   << ",\"state\":\""
                   << escape_json(update_state_name(status.PackageUpdateState)) << "\""
                   << ",\"transferredBytes\":" << status.PackageBytesDownloaded
                   << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
                   << "}\n";
        }
        catch (...)
        {
        }
    }

    StoreInstallResultFile read_store_install_result(
        const std::filesystem::path& result_path)
    {
        StoreInstallResultFile result;
        std::ifstream input(result_path, std::ios::binary);
        if (!input)
        {
            return result;
        }
        result.available = true;
        std::getline(input, result.state);
        std::getline(input, result.hresult);
        std::getline(input, result.reason);
        return result;
    }

    std::array<uint16_t, 4> parse_package_version(const std::wstring& value)
    {
        std::array<uint16_t, 4> result{};
        std::wistringstream input(value);
        std::wstring part;
        size_t index = 0;
        while (std::getline(input, part, L'.'))
        {
            if (part.empty() || index >= result.size() ||
                !std::all_of(part.begin(), part.end(), [](wchar_t character)
                {
                    return character >= L'0' && character <= L'9';
                }))
            {
                throw hresult_invalid_argument(L"Invalid Store package version");
            }
            const unsigned long parsed = std::stoul(part);
            if (parsed > UINT16_MAX)
            {
                throw hresult_invalid_argument(L"Invalid Store package version");
            }
            result[index++] = static_cast<uint16_t>(parsed);
        }
        if (index == 0)
        {
            throw hresult_invalid_argument(L"Invalid Store package version");
        }
        return result;
    }

    bool is_valid_package_family_name(const std::wstring& value)
    {
        const auto separator = value.rfind(L'_');
        if (separator == std::wstring::npos ||
            separator == 0 ||
            separator == value.size() - 1 ||
            value.size() > 161)
        {
            return false;
        }
        return std::all_of(value.begin(), value.end(), [](wchar_t character)
        {
            return character == L'.' ||
                character == L'_' ||
                character == L'-' ||
                (character >= L'0' && character <= L'9') ||
                (character >= L'A' && character <= L'Z') ||
                (character >= L'a' && character <= L'z');
        });
    }

    void ensure_plain_diagnostic_directory(
        const std::filesystem::path& directory_path,
        bool allow_create)
    {
        DWORD attributes = GetFileAttributesW(directory_path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES && allow_create)
        {
            const DWORD inspect_error = GetLastError();
            if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(inspect_error),
                    L"Unable to inspect the fixed legacy cleanup diagnostic directory");
            }
            if (!CreateDirectoryW(directory_path.c_str(), nullptr))
            {
                const DWORD create_error = GetLastError();
                if (create_error != ERROR_ALREADY_EXISTS)
                {
                    throw hresult_error(
                        HRESULT_FROM_WIN32(create_error),
                        L"Unable to create the fixed legacy cleanup diagnostic directory");
                }
            }
            attributes = GetFileAttributesW(directory_path.c_str());
        }
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup diagnostic directory is missing, not a directory, or a reparse point");
        }
    }

    std::filesystem::path resolve_legacy_cleanup_diagnostics_directory(
        const LegacyTransitionOptions& options)
    {
        if (!is_valid_package_family_name(options.package_family_name) ||
            !is_canonical_uuid(options.transition_id) ||
            !is_canonical_uuid(options.attempt_id))
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup diagnostics require a valid package family and canonical IDs");
        }
        const std::filesystem::path local_app_data = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for legacy cleanup diagnostics");
        if (!local_app_data.is_absolute() ||
            normalize_absolute_path(local_app_data) ==
                normalize_absolute_path(local_app_data.root_path()))
        {
            throw hresult_invalid_argument(L"LOCALAPPDATA is unsafe for legacy cleanup diagnostics");
        }

        const std::filesystem::path memmy_directory = local_app_data / L"Memmy";
        if (!options.legacy_install_directory.empty() &&
            paths_overlap(options.legacy_install_directory, memmy_directory))
        {
            throw hresult_invalid_argument(
                L"Refusing to initialize Store transition diagnostics inside an overlapping legacy install path");
        }
        const std::filesystem::path diagnostics_root =
            memmy_directory / L"store-transition" / L"diagnostics";
        const std::filesystem::path transition_directory = diagnostics_root.parent_path();
        const std::filesystem::path diagnostics_directory =
            diagnostics_root /
            options.package_family_name /
            options.transition_id /
            options.attempt_id;
        if (!is_path_within_directory(diagnostics_directory, transition_directory))
        {
            throw hresult_invalid_argument(L"Legacy cleanup diagnostic path escaped its fixed root");
        }

        ensure_plain_diagnostic_directory(local_app_data, false);
        ensure_plain_diagnostic_directory(memmy_directory, true);
        ensure_plain_diagnostic_directory(transition_directory, true);
        ensure_plain_diagnostic_directory(diagnostics_root, true);
        ensure_plain_diagnostic_directory(
            diagnostics_root / options.package_family_name,
            true);
        ensure_plain_diagnostic_directory(
            diagnostics_root / options.package_family_name / options.transition_id,
            true);
        ensure_plain_diagnostic_directory(diagnostics_directory, true);
        return diagnostics_directory;
    }

    void initialize_legacy_cleanup_diagnostics(
        const LegacyTransitionOptions& options,
        const std::string& process_role)
    {
        LegacyCleanupDiagnostics diagnostics;
        diagnostics.directory_path = resolve_legacy_cleanup_diagnostics_directory(options);
        diagnostics.process_role = process_role;
        diagnostics.failure_process_role = process_role;
        diagnostics.transition_id = utf8(options.transition_id);
        diagnostics.attempt_id = utf8(options.attempt_id);
        diagnostics.process_id = GetCurrentProcessId();
        diagnostics.log_path = diagnostics.directory_path /
            (L"events-" + std::wstring(process_role.begin(), process_role.end()) +
                L"-" + std::to_wstring(diagnostics.process_id) + L".jsonl");
        diagnostics.current_operation = "diagnostic-channel-initialize";
        diagnostics.current_target = utf8(diagnostics.directory_path.wstring());
        legacy_cleanup_diagnostics = std::move(diagnostics);
        auto& active_diagnostics = *legacy_cleanup_diagnostics;

        active_diagnostics.session_id_available = ProcessIdToSessionId(
            active_diagnostics.process_id,
            &active_diagnostics.session_id) != FALSE;
        if (!active_diagnostics.session_id_available)
        {
            const DWORD error = GetLastError();
            set_legacy_cleanup_failure_context(
                "ProcessIdToSessionId",
                std::to_string(active_diagnostics.process_id),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to resolve the legacy cleanup process session");
        }

        UINT32 package_name_length = 0;
        active_diagnostics.package_identity_result = GetCurrentPackageFullName(
            &package_name_length,
            nullptr);
        if (active_diagnostics.package_identity_result == ERROR_INSUFFICIENT_BUFFER &&
            package_name_length > 0)
        {
            std::vector<wchar_t> package_name(package_name_length);
            active_diagnostics.package_identity_result = GetCurrentPackageFullName(
                &package_name_length,
                package_name.data());
            if (active_diagnostics.package_identity_result != ERROR_SUCCESS)
            {
                set_legacy_cleanup_failure_context(
                    "GetCurrentPackageFullName",
                    utf8(current_executable_path().wstring()),
                    static_cast<DWORD>(active_diagnostics.package_identity_result));
                throw hresult_error(
                    HRESULT_FROM_WIN32(active_diagnostics.package_identity_result),
                    L"Unable to resolve the legacy cleanup package identity");
            }
            active_diagnostics.has_package_identity = true;
            active_diagnostics.package_full_name = utf8(std::wstring(package_name.data()));
        }
        else if (active_diagnostics.package_identity_result != APPMODEL_ERROR_NO_PACKAGE)
        {
            set_legacy_cleanup_failure_context(
                "GetCurrentPackageFullName",
                utf8(current_executable_path().wstring()),
                static_cast<DWORD>(active_diagnostics.package_identity_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(active_diagnostics.package_identity_result),
                L"Unable to query the legacy cleanup package identity");
        }

        if (!append_legacy_cleanup_diagnostic(
                "process-context",
                "started",
                "query-process-context",
                utf8(current_executable_path().wstring())))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                L"Unable to initialize the fixed legacy cleanup diagnostic log");
        }

        const std::filesystem::path process_result_path =
            legacy_cleanup_diagnostics->directory_path /
            (L"process-" + std::to_wstring(GetCurrentProcessId()) + L".result");
        write_text_file_atomic(
            process_result_path,
            "legacy-cleanup-result-v2\n" +
                single_line(legacy_cleanup_diagnostics->process_role) + "\n" +
                single_line(legacy_cleanup_diagnostics->failure_process_role) + "\n" +
                single_line(legacy_cleanup_diagnostics->transition_id) + "\n" +
                single_line(legacy_cleanup_diagnostics->attempt_id) + "\n0\n\n" +
                "diagnostic-channel-initialize\n" +
                single_line(utf8(process_result_path.wstring())) + "\nready\n");
        if (!append_legacy_cleanup_diagnostic(
                "diagnostic-channel",
                "ready",
                "write-result-channel-sentinel",
                utf8(process_result_path.wstring())))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                L"Unable to verify the fixed legacy cleanup diagnostic log");
        }
        legacy_cleanup_diagnostics->current_operation.clear();
        legacy_cleanup_diagnostics->current_target.clear();
    }

    std::filesystem::path legacy_cleanup_process_result_path(DWORD process_id)
    {
        if (!legacy_cleanup_diagnostics)
        {
            throw hresult_error(E_UNEXPECTED, L"Legacy cleanup diagnostics are not initialized");
        }
        return legacy_cleanup_diagnostics->directory_path /
            (L"process-" + std::to_wstring(process_id) + L".result");
    }

    void write_legacy_cleanup_process_failure(
        HRESULT hresult,
        const std::string& message) noexcept
    {
        try
        {
            if (!legacy_cleanup_diagnostics)
            {
                return;
            }
            const std::optional<DWORD> win32_error =
                legacy_cleanup_diagnostics->current_win32_error
                    ? legacy_cleanup_diagnostics->current_win32_error
                    : win32_error_from_hresult(hresult);
            append_legacy_cleanup_diagnostic(
                "process-error",
                "failed",
                legacy_cleanup_diagnostics->current_operation,
                legacy_cleanup_diagnostics->current_target,
                win32_error,
                hresult,
                message);
            write_text_file_atomic(
                legacy_cleanup_process_result_path(GetCurrentProcessId()),
                "legacy-cleanup-result-v2\n" +
                    single_line(legacy_cleanup_diagnostics->process_role) + "\n" +
                    single_line(legacy_cleanup_diagnostics->failure_process_role) + "\n" +
                    single_line(legacy_cleanup_diagnostics->transition_id) + "\n" +
                    single_line(legacy_cleanup_diagnostics->attempt_id) + "\n" +
                    std::to_string(static_cast<int32_t>(hresult)) + "\n" +
                    (win32_error ? std::to_string(*win32_error) : "") + "\n" +
                    single_line(legacy_cleanup_diagnostics->current_operation) + "\n" +
                    single_line(legacy_cleanup_diagnostics->current_target) + "\n" +
                    single_line(message) + "\n");
        }
        catch (...)
        {
        }
    }

    void write_legacy_cleanup_error_to_stderr(
        HRESULT hresult,
        const std::string& message) noexcept
    {
        try
        {
            std::cerr << "{\"type\":\"error\",\"hresult\":"
                      << static_cast<int32_t>(hresult);
            if (legacy_cleanup_diagnostics)
            {
                const std::optional<DWORD> win32_error =
                    legacy_cleanup_diagnostics->current_win32_error
                        ? legacy_cleanup_diagnostics->current_win32_error
                        : win32_error_from_hresult(hresult);
                std::cerr << ",\"processRole\":\""
                          << escape_json(legacy_cleanup_diagnostics->process_role) << "\""
                          << ",\"failureProcessRole\":\""
                          << escape_json(legacy_cleanup_diagnostics->failure_process_role) << "\""
                          << ",\"transitionId\":\""
                          << escape_json(legacy_cleanup_diagnostics->transition_id) << "\""
                          << ",\"attemptId\":\""
                          << escape_json(legacy_cleanup_diagnostics->attempt_id) << "\""
                          << ",\"operation\":\""
                          << escape_json(legacy_cleanup_diagnostics->current_operation) << "\""
                          << ",\"target\":\""
                          << escape_json(legacy_cleanup_diagnostics->current_target) << "\"";
                if (win32_error)
                {
                    std::cerr << ",\"win32Error\":" << *win32_error;
                }
            }
            std::cerr << ",\"message\":\"" << escape_json(message) << "\"}\n";
            std::cerr.flush();
        }
        catch (...)
        {
        }
    }

    LegacyCleanupProcessResult read_legacy_cleanup_process_result(DWORD process_id)
    {
        LegacyCleanupProcessResult result;
        std::ifstream input(legacy_cleanup_process_result_path(process_id), std::ios::binary);
        if (!input)
        {
            return result;
        }
        std::string schema;
        std::string hresult_value;
        std::string win32_error_value;
        std::getline(input, schema);
        std::getline(input, result.process_role);
        std::getline(input, result.failure_process_role);
        std::getline(input, result.transition_id);
        std::getline(input, result.attempt_id);
        std::getline(input, hresult_value);
        std::getline(input, win32_error_value);
        std::getline(input, result.operation);
        std::getline(input, result.target);
        std::getline(input, result.message);
        if (schema != "legacy-cleanup-result-v2" ||
            result.process_role.empty() ||
            result.failure_process_role.empty() ||
            result.transition_id.empty() ||
            result.attempt_id.empty() ||
            hresult_value.empty())
        {
            return {};
        }
        try
        {
            size_t consumed = 0;
            const long long parsed = std::stoll(hresult_value, &consumed, 10);
            if (consumed != hresult_value.size() || parsed < INT32_MIN || parsed > INT32_MAX)
            {
                return {};
            }
            result.hresult = static_cast<HRESULT>(static_cast<int32_t>(parsed));
            if (!win32_error_value.empty())
            {
                size_t win32_consumed = 0;
                const unsigned long parsed_win32 = std::stoul(
                    win32_error_value,
                    &win32_consumed,
                    10);
                if (win32_consumed != win32_error_value.size())
                {
                    return {};
                }
                result.win32_error = static_cast<DWORD>(parsed_win32);
            }
            result.available = FAILED(result.hresult);
            return result;
        }
        catch (...)
        {
            return {};
        }
    }

    bool is_valid_package_full_name(const std::wstring& value)
    {
        return !value.empty() && value.size() <= PACKAGE_FULL_NAME_MAX_LENGTH &&
            std::all_of(value.begin(), value.end(), [](wchar_t character)
            {
                return character == L'.' ||
                    character == L'_' ||
                    character == L'-' ||
                    (character >= L'0' && character <= L'9') ||
                    (character >= L'A' && character <= L'Z') ||
                    (character >= L'a' && character <= L'z');
            });
    }

    DWORD parse_process_id(const std::wstring& value)
    {
        if (value.empty())
        {
            throw hresult_invalid_argument(L"--old-pid is required");
        }
        wchar_t* end = nullptr;
        const unsigned long parsed = std::wcstoul(value.c_str(), &end, 10);
        if (end == value.c_str() || *end != L'\0' || parsed == 0)
        {
            throw hresult_invalid_argument(L"--old-pid must be a non-zero process ID");
        }
        return static_cast<DWORD>(parsed);
    }

    void validate_store_install_handoff_options(
        const StoreInstallHandoffOptions& options,
        bool require_external_helper_path)
    {
        parse_package_version(options.baseline_package_version);
        if (options.created_at.empty() ||
            !is_valid_package_full_name(options.baseline_package_full_name) ||
            !is_valid_aumid(options.aumid) ||
            !is_valid_package_family_name(options.package_family_name) ||
            (options.mode != L"manual" && options.mode != L"silent") ||
            options.old_process_id == 0)
        {
            throw hresult_invalid_argument(L"Invalid Store update handoff metadata");
        }
        if (!options.state_path.is_absolute() ||
            !options.result_path.is_absolute() ||
            !options.log_path.is_absolute() ||
            options.state_path.filename() != L"store-update-install-state-v2.json" ||
            options.result_path.filename() != L"store-update-result-v1.txt" ||
            options.log_path.filename() != L"store-update-handoff.jsonl")
        {
            throw hresult_invalid_argument(L"Invalid Store update handoff paths");
        }
        const std::filesystem::path namespace_directory = options.state_path.parent_path();
        if (namespace_directory.filename() != options.package_family_name ||
            namespace_directory.parent_path().filename() != L"store-update")
        {
            throw hresult_invalid_argument(L"Store update state is outside its package family namespace");
        }
        const std::filesystem::path expected_handoff_directory =
            namespace_directory / L"handoff";
        if (normalize_absolute_path(options.result_path.parent_path()) !=
                normalize_absolute_path(expected_handoff_directory) ||
            normalize_absolute_path(options.log_path.parent_path()) !=
                normalize_absolute_path(expected_handoff_directory))
        {
            throw hresult_invalid_argument(L"Store update handoff paths do not share the expected directory");
        }
        if (require_external_helper_path)
        {
            const std::filesystem::path expected_external_helper =
                resolve_environment_path(
                    L"LOCALAPPDATA",
                    L"LOCALAPPDATA is unavailable for Store update finalization") /
                L"Memmy" /
                L"store-update" /
                options.package_family_name /
                L"MemmyStoreUpdate.exe";
            if (!options.external_helper_path.is_absolute() ||
                normalize_absolute_path(options.external_helper_path) !=
                    normalize_absolute_path(expected_external_helper) ||
                is_windows_apps_path(options.external_helper_path) ||
                !std::filesystem::is_regular_file(options.external_helper_path))
            {
                throw hresult_invalid_argument(L"Invalid external Store update helper path");
            }
        }
    }

    std::vector<std::wstring> registered_package_full_names(
        const std::wstring& package_family_name)
    {
        if (package_family_name.empty())
        {
            throw hresult_invalid_argument(L"Package family name is required");
        }

        UINT32 count = 0;
        UINT32 buffer_length = 0;
        LONG result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            nullptr,
            &buffer_length,
            nullptr);
        if (result == ERROR_SUCCESS)
        {
            if (count != 0)
            {
                throw hresult_error(
                    E_UNEXPECTED,
                    L"Package registration query returned names without a buffer");
            }
            return {};
        }
        if (result != ERROR_INSUFFICIENT_BUFFER)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to query package-family registration");
        }

        for (unsigned int attempt = 0; attempt < 4; ++attempt)
        {
            if (count == 0 || buffer_length == 0)
            {
                throw hresult_error(
                    E_UNEXPECTED,
                    L"Package registration query returned an invalid buffer size");
            }

            std::vector<wchar_t*> package_full_names(count);
            std::vector<wchar_t> package_full_name_buffer(buffer_length);
            UINT32 read_count = count;
            UINT32 read_buffer_length = buffer_length;
            result = GetPackagesByPackageFamily(
                package_family_name.c_str(),
                &read_count,
                package_full_names.data(),
                &read_buffer_length,
                package_full_name_buffer.data());
            if (result == ERROR_INSUFFICIENT_BUFFER)
            {
                count = read_count;
                buffer_length = read_buffer_length;
                continue;
            }
            if (result != ERROR_SUCCESS)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(result),
                    L"Unable to read package-family registration");
            }

            std::vector<std::wstring> result_full_names;
            result_full_names.reserve(read_count);
            for (UINT32 index = 0; index < read_count; ++index)
            {
                if (index >= package_full_names.size() ||
                    package_full_names[index] == nullptr ||
                    package_full_names[index][0] == L'\0')
                {
                    throw hresult_error(
                        E_UNEXPECTED,
                        L"Package registration query returned an invalid package full name");
                }
                result_full_names.emplace_back(package_full_names[index]);
            }
            return result_full_names;
        }

        throw hresult_error(
            HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER),
            L"Package-family registration changed during the query");
    }

    void emit_package_family_registration(const std::wstring& package_family_name)
    {
        const auto package_full_names =
            registered_package_full_names(package_family_name);
        std::ostringstream output;
        output << "{\"type\":\"package-family-registration\""
               << ",\"packageFamilyName\":\""
               << escape_json(utf8(package_family_name)) << "\""
               << ",\"registered\":"
               << (package_full_names.empty() ? "false" : "true")
               << ",\"packageFullNames\":[";
        for (size_t index = 0; index < package_full_names.size(); ++index)
        {
            if (index != 0)
            {
                output << ',';
            }
            output << '\"' << escape_json(utf8(package_full_names[index])) << '\"';
        }
        output << "]}";
        write_json_line(output.str());
    }

    struct InstalledPackageIdentity
    {
        std::wstring full_name;
        std::array<uint16_t, 4> version;
    };

    std::optional<InstalledPackageIdentity> installed_package_identity(
        const std::wstring& package_family_name)
    {
        UINT32 count = 0;
        UINT32 buffer_length = 0;
        LONG result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            nullptr,
            &buffer_length,
            nullptr);
        if (result == ERROR_SUCCESS && count == 0)
        {
            return std::nullopt;
        }
        if (result != ERROR_INSUFFICIENT_BUFFER)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to query the installed Store package");
        }

        std::vector<wchar_t*> package_full_names(count);
        std::vector<wchar_t> package_full_name_buffer(buffer_length);
        result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            package_full_names.data(),
            &buffer_length,
            package_full_name_buffer.data());
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the installed Store package");
        }

        std::optional<InstalledPackageIdentity> latest;
        for (UINT32 index = 0; index < count; ++index)
        {
            UINT32 package_id_length = 0;
            LONG id_result = PackageIdFromFullName(
                package_full_names[index],
                PACKAGE_INFORMATION_BASIC,
                &package_id_length,
                nullptr);
            if (id_result != ERROR_INSUFFICIENT_BUFFER)
            {
                continue;
            }
            std::vector<unsigned char> package_id_storage(package_id_length);
            auto* package_id = reinterpret_cast<PACKAGE_ID*>(package_id_storage.data());
            id_result = PackageIdFromFullName(
                package_full_names[index],
                PACKAGE_INFORMATION_BASIC,
                &package_id_length,
                reinterpret_cast<BYTE*>(package_id));
            if (id_result != ERROR_SUCCESS)
            {
                continue;
            }
            const std::array<uint16_t, 4> version{
                package_id->version.Major,
                package_id->version.Minor,
                package_id->version.Build,
                package_id->version.Revision
            };
            if (!latest || version > latest->version)
            {
                latest = InstalledPackageIdentity{package_full_names[index], version};
            }
        }
        return latest;
    }

    bool installed_package_replaced_baseline(const StoreInstallHandoffOptions& options)
    {
        const auto installed = installed_package_identity(options.package_family_name);
        if (!installed)
        {
            return false;
        }
        const auto baseline_version = parse_package_version(options.baseline_package_version);
        return installed->version > baseline_version ||
            (installed->version == baseline_version &&
             installed->full_name != options.baseline_package_full_name);
    }

    void write_failed_store_install_state(
        const StoreInstallHandoffOptions& options,
        const std::string& native_state,
        const std::string& hresult,
        const std::string& reason)
    {
        const std::string created_at = escape_json(utf8(options.created_at));
        const std::string timestamp = utc_timestamp();
        const bool manual = options.mode == L"manual";
        std::ostringstream output;
        output << "{\n"
               << "  \"schemaVersion\": 2,\n"
               << "  \"mode\": \"" << (manual ? "manual" : "silent") << "\",\n"
               << "  \"status\": \"failed\",\n"
               << "  \"baselinePackageVersion\": \""
               << escape_json(utf8(options.baseline_package_version)) << "\",\n"
               << "  \"baselinePackageFullName\": \""
               << escape_json(utf8(options.baseline_package_full_name)) << "\",\n"
               << "  \"oldPid\": " << options.old_process_id << ",\n"
               << "  \"createdAt\": \"" << created_at << "\",\n"
               << "  \"updatedAt\": \"" << timestamp << "\",\n"
               << "  \"autoActivateOnSuccess\": " << (manual ? "true" : "false") << ",\n"
               << "  \"aumid\": \"" << escape_json(utf8(options.aumid)) << "\",\n"
               << "  \"packageFamilyName\": \"" << escape_json(utf8(options.package_family_name)) << "\",\n"
               << "  \"nativeState\": \"" << escape_json(native_state) << "\",\n"
               << "  \"hresult\": "
               << (hresult.empty() ? "null" : "\"" + escape_json(hresult) + "\"") << ",\n"
               << "  \"failureReason\": \"" << escape_json(single_line(reason)) << "\",\n"
               << "  \"failurePending\": true\n"
               << "}\n";
        write_text_file_atomic(options.state_path, output.str());
    }

    void activate_store_application(const std::wstring& aumid)
    {
        com_ptr<IApplicationActivationManager> activation_manager;
        check_hresult(CoCreateInstance(
            CLSID_ApplicationActivationManager,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(activation_manager.put())));
        DWORD process_id = 0;
        check_hresult(activation_manager->ActivateApplication(
            aumid.c_str(),
            nullptr,
            AO_NONE,
            &process_id));
    }

    bool activate_store_application_with_retry(
        const StoreInstallHandoffOptions& options,
        const std::string& state) noexcept
    {
        for (int attempt = 1; attempt <= 10; ++attempt)
        {
            try
            {
                activate_store_application(options.aumid);
                append_handoff_log(options.log_path, "application-activated", state);
                return true;
            }
            catch (const hresult_error& error)
            {
                append_handoff_log(
                    options.log_path,
                    "application-activation-retry",
                    state,
                    hresult_text(error.code()),
                    to_string(error.message()));
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        append_handoff_log(
            options.log_path,
            "application-activation-failed",
            state,
            "",
            "AUMID activation did not succeed after 10 attempts");
        return false;
    }

    std::vector<std::wstring> build_store_finalizer_arguments(
        const std::filesystem::path& executable_path,
        const std::wstring& command,
        const StoreInstallHandoffOptions& options,
        bool include_external_helper_path)
    {
        std::vector<std::wstring> arguments{
            executable_path.wstring(),
            command,
            L"--state-path", options.state_path.wstring(),
            L"--result-path", options.result_path.wstring(),
            L"--log-path", options.log_path.wstring(),
            L"--old-pid", std::to_wstring(options.old_process_id),
            L"--baseline-package-version", options.baseline_package_version,
            L"--baseline-package-full-name", options.baseline_package_full_name,
            L"--created-at", options.created_at,
            L"--aumid", options.aumid,
            L"--package-family-name", options.package_family_name,
            L"--mode", options.mode
        };
        if (include_external_helper_path)
        {
            arguments.insert(arguments.end(), {
                L"--external-helper-path",
                options.external_helper_path.wstring()
            });
        }
        return arguments;
    }

    void launch_detached_process(
        const std::filesystem::path& executable_path,
        const std::vector<std::wstring>& arguments,
        bool set_breakaway_policy)
    {
        std::wstring command_line;
        for (const auto& argument : arguments)
        {
            if (!command_line.empty())
            {
                command_line.push_back(L' ');
            }
            command_line.append(quote_command_line_argument(argument));
        }

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        std::vector<unsigned char> attribute_storage;
        if (set_breakaway_policy)
        {
            SIZE_T attribute_list_size = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_list_size);
            attribute_storage.resize(attribute_list_size);
            startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
                attribute_storage.data());
            if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    &attribute_list_size))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to initialize the Store update finalizer policy");
            }
            DWORD desktop_app_policy =
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE |
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE;
            if (!UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY,
                    &desktop_app_policy,
                    sizeof(desktop_app_policy),
                    nullptr,
                    nullptr))
            {
                const DWORD error = GetLastError();
                DeleteProcThreadAttributeList(startup.lpAttributeList);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to set the Store update finalizer breakaway policy");
            }
        }

        PROCESS_INFORMATION process{};
        const DWORD creation_flags = CREATE_NO_WINDOW | DETACHED_PROCESS |
            (set_breakaway_policy ? EXTENDED_STARTUPINFO_PRESENT : 0);
        const BOOL created = CreateProcessW(
            executable_path.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            creation_flags,
            nullptr,
            executable_path.parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        if (startup.lpAttributeList != nullptr)
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
        }
        if (!created)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(create_error),
                L"Unable to start the Store update finalizer process");
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }

    void validate_legacy_transition_options(
        const LegacyTransitionOptions& options,
        bool require_identity,
        bool require_external_helper)
    {
        if (options.legacy_install_directory.empty() ||
            options.legacy_executable_path.empty())
        {
            throw hresult_invalid_argument(
                L"Legacy takeover requires --legacy-install-directory and --legacy-executable-path");
        }
        if (require_identity &&
            (!is_valid_aumid(options.aumid) ||
             !is_valid_package_family_name(options.package_family_name) ||
             options.aumid != options.package_family_name + L"!Memmy" ||
             !is_canonical_uuid(options.transition_id) ||
             !is_canonical_uuid(options.attempt_id)))
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup Store identity or diagnostic IDs are invalid");
        }
        if (!options.shortcut_path.empty())
        {
            const std::filesystem::path expected_desktop_shortcut =
                resolve_known_folder_path(
                    FOLDERID_Desktop,
                    L"The current user's Desktop directory is unavailable for legacy cleanup") /
                L"Memmy.lnk";
            if (!options.shortcut_path.is_absolute() ||
                normalize_absolute_path(options.shortcut_path) !=
                    normalize_absolute_path(expected_desktop_shortcut))
            {
                throw hresult_invalid_argument(
                    L"--shortcut must be the current user's fixed Desktop Memmy.lnk path");
            }
        }
        if (require_external_helper)
        {
            const std::filesystem::path expected_helper =
                resolve_known_folder_path(
                    FOLDERID_LocalAppData,
                    L"The current user's Local AppData directory is unavailable for legacy cleanup") /
                L"Memmy" /
                L"store-transition" /
                L"native" /
                options.package_family_name /
                L"MemmyStoreUpdate.exe";
            std::error_code file_error;
            if (!options.external_helper_path.is_absolute() ||
                normalize_absolute_path(options.external_helper_path) !=
                    normalize_absolute_path(expected_helper) ||
                is_windows_apps_path(options.external_helper_path) ||
                !std::filesystem::is_regular_file(options.external_helper_path, file_error) ||
                file_error)
            {
                throw hresult_invalid_argument(
                    L"Refusing to use an unexpected unpackaged legacy cleanup helper");
            }
        }
    }

    std::vector<std::wstring> build_legacy_cleanup_arguments(
        const std::filesystem::path& executable_path,
        const std::wstring& command,
        const LegacyTransitionOptions& options,
        bool include_external_helper)
    {
        std::vector<std::wstring> arguments{
            executable_path.wstring(),
            command,
            L"--legacy-install-directory", options.legacy_install_directory.wstring(),
            L"--legacy-executable-path", options.legacy_executable_path.wstring(),
            L"--aumid", options.aumid,
            L"--package-family-name", options.package_family_name,
            L"--transition-id", options.transition_id,
            L"--attempt-id", options.attempt_id
        };
        if (include_external_helper)
        {
            arguments.insert(arguments.end(), {
                L"--external-helper-path",
                options.external_helper_path.wstring()
            });
        }
        if (!options.shortcut_path.empty())
        {
            arguments.insert(arguments.end(), {
                L"--shortcut",
                options.shortcut_path.wstring()
            });
        }
        if (!options.legacy_install_fingerprint.empty()) {
            arguments.insert(arguments.end(), { L"--legacy-install-fingerprint", options.legacy_install_fingerprint });
        }
        return arguments;
    }

    std::string legacy_cleanup_process_role_for_command(const std::wstring& command)
    {
        if (command == L"finalize-legacy-cleanup-breakaway-launcher")
        {
            return "breakaway-launcher";
        }
        if (command == L"finalize-legacy-cleanup-unpackaged")
        {
            return "external-unpackaged-helper";
        }
        return "unknown-child";
    }

    void run_legacy_cleanup_process(
        const std::filesystem::path& executable_path,
        const std::vector<std::wstring>& arguments,
        bool set_breakaway_policy)
    {
        if (arguments.size() < 2)
        {
            throw hresult_invalid_argument(L"Legacy cleanup child command is missing");
        }
        const std::string expected_child_role =
            legacy_cleanup_process_role_for_command(arguments[1]);
        std::wstring command_line;
        for (const auto& argument : arguments)
        {
            if (!command_line.empty())
            {
                command_line.push_back(L' ');
            }
            command_line.append(quote_command_line_argument(argument));
        }
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        std::vector<unsigned char> attribute_storage;
        if (set_breakaway_policy)
        {
            SIZE_T attribute_list_size = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_list_size);
            attribute_storage.resize(attribute_list_size);
            startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
                attribute_storage.data());
            if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    &attribute_list_size))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to initialize the legacy cleanup breakaway policy");
            }
            DWORD desktop_app_policy =
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE |
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE;
            if (!UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY,
                    &desktop_app_policy,
                    sizeof(desktop_app_policy),
                    nullptr,
                    nullptr))
            {
                const DWORD error = GetLastError();
                DeleteProcThreadAttributeList(startup.lpAttributeList);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to set the legacy cleanup breakaway policy");
            }
        }
        PROCESS_INFORMATION process{};
        const DWORD creation_flags = CREATE_NO_WINDOW |
            (set_breakaway_policy ? EXTENDED_STARTUPINFO_PRESENT : 0);
        const BOOL created = CreateProcessW(
            executable_path.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            creation_flags,
            nullptr,
            executable_path.parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        if (startup.lpAttributeList != nullptr)
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
        }
        if (!created)
        {
            append_legacy_cleanup_diagnostic(
                "child-process-create",
                "error",
                expected_child_role,
                utf8(executable_path.wstring()),
                create_error,
                HRESULT_FROM_WIN32(create_error));
            throw hresult_error(
                HRESULT_FROM_WIN32(create_error),
                L"Unable to start unpackaged legacy cleanup");
        }
        const DWORD child_process_id = process.dwProcessId;
        append_legacy_cleanup_diagnostic(
            "child-process-create",
            "success",
            expected_child_role,
            utf8(executable_path.wstring()),
            ERROR_SUCCESS,
            S_OK,
            "childPid=" + std::to_string(child_process_id));
        CloseHandle(process.hThread);
        const DWORD wait_timeout_milliseconds = set_breakaway_policy ? 150000 : 120000;
        const DWORD wait_result = WaitForSingleObject(
            process.hProcess,
            wait_timeout_milliseconds);
        if (wait_result == WAIT_TIMEOUT)
        {
            const BOOL terminated = TerminateProcess(process.hProcess, ERROR_TIMEOUT);
            const DWORD terminate_error = terminated ? ERROR_SUCCESS : GetLastError();
            const DWORD termination_wait_result = WaitForSingleObject(process.hProcess, 5000);
            CloseHandle(process.hProcess);
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "timeout",
                expected_child_role,
                utf8(executable_path.wstring()),
                ERROR_TIMEOUT,
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                "childPid=" + std::to_string(child_process_id) +
                    "; waitTimeoutMilliseconds=" + std::to_string(wait_timeout_milliseconds) +
                    "; terminateProcess=" + (terminated ? "success" : "failed") +
                    "; terminateWin32=" + std::to_string(terminate_error) +
                    "; terminationWaitResult=" + std::to_string(termination_wait_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Unpackaged legacy cleanup timed out");
        }
        if (wait_result != WAIT_OBJECT_0)
        {
            const DWORD wait_error = GetLastError();
            CloseHandle(process.hProcess);
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "wait-error",
                expected_child_role,
                utf8(executable_path.wstring()),
                wait_error,
                HRESULT_FROM_WIN32(wait_error),
                "childPid=" + std::to_string(child_process_id));
            throw hresult_error(
                HRESULT_FROM_WIN32(wait_error),
                L"Unable to wait for unpackaged legacy cleanup");
        }
        DWORD exit_code = ERROR_GEN_FAILURE;
        const BOOL read_exit_code = GetExitCodeProcess(process.hProcess, &exit_code);
        const DWORD exit_error = read_exit_code ? ERROR_SUCCESS : GetLastError();
        CloseHandle(process.hProcess);
        if (!read_exit_code)
        {
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "exit-code-error",
                expected_child_role,
                utf8(executable_path.wstring()),
                exit_error,
                HRESULT_FROM_WIN32(exit_error),
                "childPid=" + std::to_string(child_process_id));
            throw hresult_error(
                HRESULT_FROM_WIN32(exit_error),
                L"Unable to read the unpackaged legacy cleanup result");
        }
        const LegacyCleanupProcessResult child_result =
            read_legacy_cleanup_process_result(child_process_id);
        const bool child_result_matches_context =
            child_result.available &&
            child_result.process_role == expected_child_role &&
            legacy_cleanup_diagnostics &&
            child_result.transition_id == legacy_cleanup_diagnostics->transition_id &&
            child_result.attempt_id == legacy_cleanup_diagnostics->attempt_id;
        append_legacy_cleanup_diagnostic(
            "child-process-result",
            exit_code == 0
                ? "success"
                : (child_result_matches_context ? "failure-preserved" : "failure-result-invalid"),
            child_result_matches_context ? child_result.operation : expected_child_role,
            child_result_matches_context ? child_result.target : utf8(executable_path.wstring()),
            child_result_matches_context ? child_result.win32_error : std::nullopt,
            child_result.available ? std::optional<HRESULT>(child_result.hresult) : std::nullopt,
            "childPid=" + std::to_string(child_process_id) +
                "; childExitCode=" + std::to_string(exit_code) +
                (child_result.available
                    ? "; childProcessRole=" + child_result.process_role +
                        "; failureProcessRole=" + child_result.failure_process_role +
                        "; childTransitionId=" + child_result.transition_id +
                        "; childAttemptId=" + child_result.attempt_id +
                        "; childOperation=" + child_result.operation +
                        "; childTarget=" + child_result.target +
                        "; childMessage=" + child_result.message
                    : ""));
        if (exit_code != 0)
        {
            if (child_result_matches_context)
            {
                legacy_cleanup_diagnostics->failure_process_role =
                    child_result.failure_process_role;
                legacy_cleanup_diagnostics->current_operation = child_result.operation;
                legacy_cleanup_diagnostics->current_target = child_result.target;
                legacy_cleanup_diagnostics->current_win32_error = child_result.win32_error;
                throw hresult_error(
                    child_result.hresult,
                    to_hstring(
                        "Legacy cleanup child failed; failureProcessRole=" +
                        child_result.failure_process_role +
                        "; childPid=" + std::to_string(child_process_id) +
                        "; operation=" + child_result.operation +
                        "; target=" + child_result.target +
                        (child_result.win32_error
                            ? "; win32Error=" + std::to_string(*child_result.win32_error)
                            : "") +
                        "; message=" + child_result.message));
            }
            const HRESULT child_exit_hresult = static_cast<HRESULT>(exit_code);
            if (FAILED(child_exit_hresult))
            {
                legacy_cleanup_diagnostics->failure_process_role = expected_child_role;
                set_legacy_cleanup_failure_context(
                    "child-result-channel",
                    utf8(executable_path.wstring()),
                    win32_error_from_hresult(child_exit_hresult));
                throw hresult_error(
                    child_exit_hresult,
                    to_hstring(
                        "Legacy cleanup child failed before it could publish a valid result; "
                        "failureProcessRole=" + expected_child_role +
                        "; childPid=" + std::to_string(child_process_id) +
                        "; childExitHresult=" + hresult_text(child_exit_hresult)));
            }
            throw hresult_error(
                E_FAIL,
                to_hstring(
                    "Legacy cleanup child failed without a valid result; expectedProcessRole=" +
                    expected_child_role + "; childPid=" + std::to_string(child_process_id) +
                    "; childExitCode=" + std::to_string(exit_code)));
        }
    }

    void finalize_legacy_cleanup_unpacked(
        const LegacyTransitionOptions& options,
        bool authority_was_attested = false,
        bool processes_already_closed = false)
    {
        begin_legacy_cleanup_operation(
            "identity-query",
            utf8(current_executable_path().wstring()));
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Refusing to mutate the real legacy installation from a packaged process");
        }
        complete_legacy_cleanup_operation("requiredPackageIdentity=false");

        begin_legacy_cleanup_operation(
            "authority-registry",
            registry_target(legacy_installer_key, L"InstallLocation"));
        bool install_exists = false;
        if (authority_was_attested)
        {
            const DWORD directory_attributes = GetFileAttributesW(
                options.legacy_install_directory.c_str());
            if (directory_attributes == INVALID_FILE_ATTRIBUTES)
            {
                const DWORD inspect_error = GetLastError();
                if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
                {
                    throw hresult_error(
                        HRESULT_FROM_WIN32(inspect_error),
                        L"Unable to inspect the attested legacy installation during cleanup recovery");
                }
            }
            else
            {
                if ((directory_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                    (directory_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                {
                    throw hresult_error(
                        E_ACCESSDENIED,
                        L"Attested legacy installation changed to an unsafe path before cleanup");
                }
                install_exists = true;
            }
        }
        else
        {
            install_exists = validate_legacy_install_authority(
                options.legacy_install_directory,
                options.legacy_executable_path);
        }
        complete_legacy_cleanup_operation(
            std::string("installExists=") + (install_exists ? "true" : "false"));
        if (install_exists)
        {
            begin_legacy_cleanup_operation(
                "legacy-processes-stop",
                utf8(options.legacy_install_directory.wstring()));
            if (processes_already_closed)
            {
                // The independent importer already verified every same-user legacy process.
            }
            else if (authority_was_attested)
            {
                // A Prepared journal proves the original executable generation.
                // A prior idempotent delete attempt may already have removed
                // Memmy.exe, so retry only the process-tree stop here instead of
                // requiring the original executable to still exist.
                stop_legacy_processes(options.legacy_install_directory);
            }
            else
            {
                prepare_legacy_takeover(options);
            }
            complete_legacy_cleanup_operation();

            begin_legacy_cleanup_operation(
                "install-directory-delete",
                utf8(options.legacy_install_directory.wstring()));
            remove_legacy_install_directory(options);
            complete_legacy_cleanup_operation();
        }
        else
        {
            append_legacy_cleanup_diagnostic(
                "legacy-processes-stop",
                "skipped-install-missing",
                "prepare-legacy-takeover",
                utf8(options.legacy_install_directory.wstring()));
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                "skipped-install-missing",
                "delete-directory-tree",
                utf8(options.legacy_install_directory.wstring()));
        }
        begin_legacy_cleanup_operation(
            "install-directory-post-check",
            utf8(options.legacy_install_directory.wstring()));
        const bool install_directory_missing = path_is_missing(
            options.legacy_install_directory);
        if (!install_directory_missing)
        {
            throw hresult_error(
                E_FAIL,
                L"Legacy Memmy install directory is still present after cleanup");
        }
        complete_legacy_cleanup_operation("missing=true");

        begin_legacy_cleanup_operation(
            "uninstall-registry-delete",
            registry_target(legacy_uninstall_key));
        delete_registry_tree_if_present(
            legacy_uninstall_key,
            KEY_WOW64_32KEY,
            "32-bit");
        delete_registry_tree_if_present(
            legacy_uninstall_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "installer-authority-registry-delete",
            registry_target(legacy_installer_key));
        delete_registry_tree_if_present(
            legacy_installer_key,
            KEY_WOW64_32KEY,
            "32-bit");
        delete_registry_tree_if_present(
            legacy_installer_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "uninstall-registry-delete",
            registry_target(legacy_uninstall_key));
        const bool uninstall_registry_32_exists = registry_tree_exists(
            legacy_uninstall_key,
            KEY_WOW64_32KEY,
            "32-bit");
        const bool uninstall_registry_64_exists = registry_tree_exists(
            legacy_uninstall_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation(
            "32BitExists=" + std::string(uninstall_registry_32_exists ? "true" : "false") +
            "; 64BitExists=" + std::string(uninstall_registry_64_exists ? "true" : "false"));

        begin_legacy_cleanup_operation(
            "installer-authority-registry-delete",
            registry_target(legacy_installer_key));
        const bool installer_registry_32_exists = registry_tree_exists(
            legacy_installer_key,
            KEY_WOW64_32KEY,
            "32-bit");
        const bool installer_registry_64_exists = registry_tree_exists(
            legacy_installer_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation(
            "32BitExists=" + std::string(installer_registry_32_exists ? "true" : "false") +
            "; 64BitExists=" + std::string(installer_registry_64_exists ? "true" : "false"));
        if (uninstall_registry_32_exists ||
            uninstall_registry_64_exists ||
            installer_registry_32_exists ||
            installer_registry_64_exists)
        {
            const bool uninstall_key_remains =
                uninstall_registry_32_exists || uninstall_registry_64_exists;
            const bool remaining_in_32_bit_view = uninstall_key_remains
                ? uninstall_registry_32_exists
                : installer_registry_32_exists;
            set_legacy_cleanup_failure_context(
                "RegOpenKeyExW(post-check)",
                registry_target(
                    uninstall_key_remains ? legacy_uninstall_key : legacy_installer_key) +
                    "; view=" + (remaining_in_32_bit_view ? "32-bit" : "64-bit"));
            throw hresult_error(
                E_FAIL,
                L"Legacy uninstall registration is still present after cleanup");
        }
        constexpr wchar_t run_key[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";

        begin_legacy_cleanup_operation(
            "run-registry-delete",
            registry_target(run_key));
        delete_registry_value_if_present(run_key, legacy_app_user_model_id);
        delete_registry_value_if_present(run_key, L"Memmy");
        delete_registry_value_if_present(run_key, L"memmy");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "user-path-update",
            "HKCU\\Environment\\Path");
        remove_legacy_cli_from_user_path(options.legacy_install_directory);
        complete_legacy_cleanup_operation();

        const std::filesystem::path start_menu_shortcut = resolve_known_folder_path(
            FOLDERID_Programs,
            L"The current user's Start Menu Programs directory is unavailable for legacy cleanup") /
            L"Memmy.lnk";
        begin_legacy_cleanup_operation(
            "start-menu-shortcut-delete",
            utf8(start_menu_shortcut.wstring()));
        const BOOL start_menu_deleted = DeleteFileW(start_menu_shortcut.c_str());
        const DWORD start_menu_error = start_menu_deleted ? ERROR_SUCCESS : GetLastError();
        append_legacy_cleanup_diagnostic(
            "start-menu-shortcut-delete",
            start_menu_deleted
                ? "success"
                : (start_menu_error == ERROR_FILE_NOT_FOUND || start_menu_error == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "DeleteFileW",
            utf8(start_menu_shortcut.wstring()),
            start_menu_error,
            HRESULT_FROM_WIN32(start_menu_error));
        if (!start_menu_deleted &&
            start_menu_error != ERROR_FILE_NOT_FOUND &&
            start_menu_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "DeleteFileW",
                utf8(start_menu_shortcut.wstring()),
                start_menu_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(start_menu_error),
                L"Unable to delete the legacy Memmy Start Menu shortcut");
        }
        const DWORD start_menu_attributes = GetFileAttributesW(start_menu_shortcut.c_str());
        if (start_menu_attributes != INVALID_FILE_ATTRIBUTES)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(start_menu_shortcut.wstring()));
            throw hresult_error(
                E_FAIL,
                L"The legacy Memmy Start Menu shortcut is still present after cleanup");
        }
        const DWORD start_menu_post_check_error = GetLastError();
        append_legacy_cleanup_diagnostic(
            "start-menu-shortcut-delete",
            start_menu_post_check_error == ERROR_FILE_NOT_FOUND ||
                    start_menu_post_check_error == ERROR_PATH_NOT_FOUND
                ? "verified-missing"
                : "verify-error",
            "GetFileAttributesW(post-check)",
            utf8(start_menu_shortcut.wstring()),
            start_menu_post_check_error,
            HRESULT_FROM_WIN32(start_menu_post_check_error));
        if (start_menu_post_check_error != ERROR_FILE_NOT_FOUND &&
            start_menu_post_check_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(start_menu_shortcut.wstring()),
                start_menu_post_check_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(start_menu_post_check_error),
                L"Unable to verify removal of the legacy Memmy Start Menu shortcut");
        }
        complete_legacy_cleanup_operation(
            "deleteResult=" + std::to_string(start_menu_error) +
            "; postCheck=" + std::to_string(start_menu_post_check_error));

        const std::filesystem::path local_app_data = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for legacy cleanup");
        const std::filesystem::path launcher_directory =
            local_app_data / L"Memmy" / L"launcher";
        begin_legacy_cleanup_operation(
            "launcher-directory-delete",
            utf8(launcher_directory.wstring()));
        const DeleteTreeResult launcher_result = delete_directory_tree_once(launcher_directory);
        append_legacy_cleanup_diagnostic(
            "launcher-directory-delete",
            launcher_result.win32_error == ERROR_SUCCESS ? "success" : "error",
            launcher_result.operation.empty() ? "delete-directory-tree" : launcher_result.operation,
            launcher_result.failed_path.empty()
                ? utf8(launcher_directory.wstring())
                : utf8(launcher_result.failed_path.wstring()),
            launcher_result.win32_error,
            HRESULT_FROM_WIN32(launcher_result.win32_error));
        if (launcher_result.win32_error != ERROR_SUCCESS)
        {
            set_legacy_cleanup_failure_context(
                launcher_result.operation.empty()
                    ? "delete-directory-tree"
                    : launcher_result.operation,
                launcher_result.failed_path.empty()
                    ? utf8(launcher_directory.wstring())
                    : utf8(launcher_result.failed_path.wstring()),
                launcher_result.win32_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(launcher_result.win32_error),
                to_hstring(
                    "Unable to remove the legacy Memmy launch proxy; operation=" +
                    launcher_result.operation + "; path=" +
                    utf8(launcher_result.failed_path.wstring())));
        }
        const DWORD launcher_attributes = GetFileAttributesW(launcher_directory.c_str());
        if (launcher_attributes != INVALID_FILE_ATTRIBUTES)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(launcher_directory.wstring()));
            throw hresult_error(
                E_FAIL,
                L"The legacy Memmy launch proxy directory is still present after cleanup");
        }
        const DWORD launcher_post_check_error = GetLastError();
        append_legacy_cleanup_diagnostic(
            "launcher-directory-delete",
            launcher_post_check_error == ERROR_FILE_NOT_FOUND ||
                    launcher_post_check_error == ERROR_PATH_NOT_FOUND
                ? "verified-missing"
                : "verify-error",
            "GetFileAttributesW(post-check)",
            utf8(launcher_directory.wstring()),
            launcher_post_check_error,
            HRESULT_FROM_WIN32(launcher_post_check_error));
        if (launcher_post_check_error != ERROR_FILE_NOT_FOUND &&
            launcher_post_check_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(launcher_directory.wstring()),
                launcher_post_check_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(launcher_post_check_error),
                L"Unable to verify removal of the legacy Memmy launch proxy directory");
        }
        complete_legacy_cleanup_operation(
            "postCheck=" + std::to_string(launcher_post_check_error));

        if (!options.shortcut_path.empty())
        {
            begin_legacy_cleanup_operation(
                "apps-folder-shortcut-create",
                utf8(options.shortcut_path.wstring()));
            create_apps_folder_shortcut(options.shortcut_path, options.aumid);
            complete_legacy_cleanup_operation();
        }
        else
        {
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "skipped-no-existing-desktop-shortcut");
        }
        append_legacy_cleanup_diagnostic("cleanup-complete", "success");
    }

    DWORD current_process_session_id()
    {
        DWORD session_id = 0;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve the current process session");
        }
        return session_id;
    }

    std::wstring token_user_sid(HANDLE token)
    {
        DWORD bytes = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
        const DWORD size_error = GetLastError();
        if (size_error != ERROR_INSUFFICIENT_BUFFER || bytes == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(size_error),
                L"Unable to size a process user token");
        }
        std::vector<unsigned char> buffer(bytes);
        if (!GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to read a process user token");
        }
        const auto token_user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
        LPWSTR sid_text = nullptr;
        if (!ConvertSidToStringSidW(token_user->User.Sid, &sid_text) || sid_text == nullptr)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to format a process user SID");
        }
        const std::wstring result(sid_text);
        LocalFree(sid_text);
        return result;
    }

    std::wstring process_user_sid(HANDLE process)
    {
        HANDLE raw_token = nullptr;
        if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open a process token for user validation");
        }
        scoped_handle token(raw_token);
        return token_user_sid(token.get());
    }

    std::wstring current_user_sid()
    {
        return process_user_sid(GetCurrentProcess());
    }

    std::optional<std::wstring> process_package_family(HANDLE process)
    {
        HANDLE raw_token = nullptr;
        if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open a process token for package-family validation");
        }
        scoped_handle token(raw_token);
        UINT32 length = 0;
        LONG result = GetPackageFamilyNameFromToken(token.get(), &length, nullptr);
        if (result == APPMODEL_ERROR_NO_PACKAGE)
        {
            return std::nullopt;
        }
        if (result != ERROR_INSUFFICIENT_BUFFER || length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to size a process package-family name");
        }
        std::vector<wchar_t> value(length);
        result = GetPackageFamilyNameFromToken(token.get(), &length, value.data());
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read a process package-family name");
        }
        return std::wstring(value.data());
    }

    std::vector<ProcessSnapshotEntry> discover_legacy_import_targets(
        std::vector<std::filesystem::path>& known_roots,
        const std::wstring& user_sid)
    {
        std::vector<ProcessSnapshotEntry> targets;
        for (auto entry : snapshot_processes())
        {
            const bool desktop = _wcsicmp(entry.executable_name.c_str(), L"Memmy.exe") == 0;
            if (!desktop && _wcsicmp(entry.executable_name.c_str(), L"node.exe") != 0 &&
                _wcsicmp(entry.executable_name.c_str(), L"memmy-memory.exe") != 0) continue;
            scoped_handle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.process_id));
            if (!process.get())
            {
                if (desktop && GetLastError() != ERROR_INVALID_PARAMETER) throw hresult_error(E_ACCESSDENIED, L"Unable to inspect a running Memmy process");
                continue;
            }
            if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) continue;
            if (!try_query_process_image_path(process.get(), entry.image_path))
            {
                if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) continue;
                if (desktop) throw hresult_error(E_ACCESSDENIED, L"Unable to inspect the Memmy executable");
                continue;
            }
            if (is_windows_apps_path(entry.image_path)) continue;
            auto directory = entry.image_path.parent_path();
            bool candidate = desktop || std::any_of(known_roots.begin(), known_roots.end(), [&](const auto& root) {
                return is_path_within_directory(entry.image_path, root);
            });
            // Include orphaned Node workers under the installed resources directory.
            for (int depth = 0; !candidate && depth < 7 && directory != directory.root_path(); ++depth, directory = directory.parent_path())
            {
                std::error_code error;
                candidate = std::filesystem::is_regular_file(directory / L"Memmy.exe", error) &&
                    std::filesystem::is_regular_file(directory / L"resources" / L"app.asar", error);
                if (candidate) { known_roots.push_back(directory); break; }
            }
            if (!candidate) continue;
            try
            {
                if (process_user_sid(process.get()) != user_sid || process_package_family(process.get())) continue;
                entry.creation_time = query_process_creation_time(process.get());
                if (entry.creation_time == 0) throw hresult_error(E_ACCESSDENIED, L"Unable to identify a running Memmy process instance");
            }
            catch (...)
            {
                if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) continue;
                std::cerr << "legacy-inspect pid=" << entry.process_id << " failed while process remains active\n";
                throw;
            }
            entry.image_path_verified = true;
            if (desktop) known_roots.push_back(entry.image_path.parent_path());
            targets.push_back(std::move(entry));
        }
        return targets;
    }

    // Only the current user's unpackaged Memmy processes are eligible, including other logon sessions.
    bool stop_legacy_for_data_import()
    {
        try
        {
            const auto user_sid = current_user_sid();
            std::vector<std::filesystem::path> roots;
            const auto started = GetTickCount64();
            const bool clear = memmy::stop_legacy_until_clear(
                [&] { return discover_legacy_import_targets(roots, user_sid); },
                [&](const auto& targets, ULONGLONG deadline) {
                    std::cerr << "legacy-stop elapsed-ms=" << GetTickCount64() - started << " targets=";
                    for (const auto& target : targets) std::cerr << target.process_id << ',';
                    std::cerr << '\n';
                    request_graceful_legacy_exit(targets);
                    const auto current = GetTickCount64();
                    const DWORD grace = static_cast<DWORD>((std::min)(deadline > current ? deadline - current : 0, 2000ULL));
                    if (!wait_for_process_snapshot_to_exit(targets, grace))
                        terminate_legacy_process_tree(targets, deadline);
                },
                [] { return GetTickCount64(); },
                [](ULONGLONG milliseconds) { Sleep(static_cast<DWORD>(milliseconds)); },
                [] {
                    try { throw; }
                    catch (const hresult_error& error) {
                        std::cerr << "legacy-stop retry hresult=" << hresult_text(error.code()) << ' ' << to_string(error.message()) << '\n';
                    }
                    catch (const std::exception& error) { std::cerr << "legacy-stop retry " << error.what() << '\n'; }
                    catch (...) { std::cerr << "legacy-stop retry unknown-error\n"; }
                }, 25'000);
            std::cerr << "legacy-stop result=" << (clear ? "clear" : "blocked") << " elapsed-ms=" << GetTickCount64() - started << '\n';
            return clear;
        }
        catch (const hresult_error& error)
        {
            std::cerr << "legacy-stop initialization hresult=" << hresult_text(error.code()) << ' ' << to_string(error.message()) << '\n';
            return false;
        }
        catch (...) { std::cerr << "legacy-stop initialization failed\n"; }
        return false;
    }

    struct StoreShortcutItemId
    {
        PIDLIST_ABSOLUTE value = nullptr;
        ~StoreShortcutItemId() { CoTaskMemFree(value); }
    };

    std::filesystem::path store_shortcut_local_app_data()
    {
        PWSTR raw = nullptr;
        const HRESULT result = SHGetKnownFolderPath(FOLDERID_LocalAppData,
            KF_FLAG_NO_PACKAGE_REDIRECTION, nullptr, &raw);
        const std::filesystem::path path(raw ? raw : L"");
        CoTaskMemFree(raw);
        check_hresult(result);
        if (path.empty()) throw hresult_error(E_UNEXPECTED, L"Local AppData is unavailable");
        return path;
    }

    std::filesystem::path store_shortcut_package_path(const LegacyTransitionOptions& options)
    {
        UINT32 length = PACKAGE_FAMILY_NAME_MAX_LENGTH;
        wchar_t family[PACKAGE_FAMILY_NAME_MAX_LENGTH]{};
        check_hresult(HRESULT_FROM_WIN32(GetCurrentPackageFamilyName(&length, family)));
        if (options.package_family_name != family)
            throw hresult_error(E_ACCESSDENIED, L"Shortcut package does not match the current package");
        length = 0;
        const LONG result = GetCurrentPackagePath(&length, nullptr);
        if (result != ERROR_INSUFFICIENT_BUFFER) check_hresult(HRESULT_FROM_WIN32(result));
        std::vector<wchar_t> path(length);
        check_hresult(HRESULT_FROM_WIN32(GetCurrentPackagePath(&length, path.data())));
        return std::filesystem::path(path.data());
    }

    // The Shell reads this icon after package upgrades have removed the old
    // WindowsApps directory. Keep it in this user's package LocalState instead.
    std::filesystem::path persist_store_shortcut_icon(const LegacyTransitionOptions& options,
        const std::filesystem::path& package_path, const std::filesystem::path& local_app_data)
    {
        const auto directory = local_app_data / L"Packages" / options.package_family_name /
            L"LocalState" / L"Memmy" / L"shell";
        std::filesystem::create_directories(directory);
        const auto icon = directory / L"memmy-shortcut-v1.ico";
        const auto temporary = directory / (L"icon-" + std::to_wstring(GetCurrentProcessId()) + L".tmp");
        if (!CopyFileW((package_path / L"app" / L"resources" / L"icon.ico").c_str(), temporary.c_str(), FALSE))
            throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Unable to copy the Store shortcut icon");
        if (!SetFileAttributesW(temporary.c_str(), FILE_ATTRIBUTE_NORMAL))
        {
            const DWORD error = GetLastError();
            DeleteFileW(temporary.c_str());
            throw hresult_error(HRESULT_FROM_WIN32(error), L"Unable to make the private shortcut icon writable");
        }
        if (!MoveFileExW(temporary.c_str(), icon.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            const DWORD error = GetLastError();
            DeleteFileW(temporary.c_str());
            throw hresult_error(HRESULT_FROM_WIN32(error), L"Unable to publish the Store shortcut icon");
        }
        return icon;
    }

    struct PinnedStoreShortcut
    {
        scoped_handle file;
        com_ptr<IShellLinkW> link;
    };

    PinnedStoreShortcut read_pinned_store_shortcut(const std::filesystem::path& path)
    {
        // Parse the same file handle that will be deleted. Deny concurrent writes
        // and renames so a different app cannot be substituted after inspection.
        PinnedStoreShortcut result;
        result.file.reset(CreateFileW(path.c_str(), GENERIC_READ | DELETE, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!result.file) return result;
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(result.file.get(), &info) ||
            (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
            info.nFileSizeHigh || !info.nFileSizeLow || info.nFileSizeLow > 1024 * 1024) return result;
        std::vector<BYTE> bytes(info.nFileSizeLow);
        DWORD read = 0;
        if (!ReadFile(result.file.get(), bytes.data(), info.nFileSizeLow, &read, nullptr) || read != info.nFileSizeLow) return result;
        com_ptr<IStream> stream;
        check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
        check_hresult(stream->Write(bytes.data(), read, nullptr));
        check_hresult(stream->Seek({}, STREAM_SEEK_SET, nullptr));
        com_ptr<IShellLinkW> link;
        check_hresult(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(link.put())));
        if (SUCCEEDED(link.as<IPersistStream>()->Load(stream.get()))) result.link = std::move(link);
        return result;
    }

    bool store_shortcut_has_identity(IShellLinkW* link, PCIDLIST_ABSOLUTE item)
    {
        StoreShortcutItemId existing;
        return SUCCEEDED(link->GetIDList(&existing.value)) && existing.value && ILIsEqual(existing.value, item);
    }

    bool store_shortcut_is_owned(IShellLinkW* link, PCIDLIST_ABSOLUTE item,
        const LegacyTransitionOptions& options, const std::filesystem::path& package_path,
        const std::filesystem::path& local_app_data, const std::vector<std::wstring>& legacy_executables)
    {
        if (store_shortcut_has_identity(link, item)) return true;
        std::vector<wchar_t> raw(32768), arguments(32768), expanded(32768);
        if (FAILED(link->GetPath(raw.data(), static_cast<int>(raw.size()), nullptr, SLGP_RAWPATH)) || !raw[0] ||
            FAILED(link->GetArguments(arguments.data(), static_cast<int>(arguments.size())))) return false;
        const DWORD length = ExpandEnvironmentStringsW(raw.data(), expanded.data(), static_cast<DWORD>(expanded.size()));
        if (!length || length > expanded.size()) return false;
        const std::filesystem::path executable(expanded.data());
        if (!executable.is_absolute()) return false;
        const auto target = normalize_absolute_path(executable);
        if (std::find(legacy_executables.begin(), legacy_executables.end(), target) != legacy_executables.end()) return true;
        // Direct links made by older packages can still contain a versioned EXE.
        const auto old_package = executable.parent_path().parent_path();
        if (_wcsicmp(executable.filename().c_str(), L"Memmy.exe") == 0 &&
            _wcsicmp(executable.parent_path().filename().c_str(), L"app") == 0 &&
            normalize_absolute_path(old_package.parent_path()) == normalize_absolute_path(package_path.parent_path()))
        {
            UINT32 length = PACKAGE_FAMILY_NAME_MAX_LENGTH;
            wchar_t family[PACKAGE_FAMILY_NAME_MAX_LENGTH]{};
            if (PackageFamilyNameFromFullName(old_package.filename().c_str(), &length, family) == ERROR_SUCCESS &&
                options.package_family_name == family) return true;
        }
        // NSIS shortcuts use the fixed per-user launch proxy, not an arbitrary
        // script whose filename happens to be MemmyLauncher.vbs.
        wchar_t windows[MAX_PATH]{};
        if (!GetWindowsDirectoryW(windows, MAX_PATH)) return false;
        const auto system = std::filesystem::path(windows);
        const auto launcher = local_app_data / L"Memmy" / L"launcher" / L"MemmyLauncher.vbs";
        const std::wstring args(arguments.data());
        return (target == normalize_absolute_path(system / L"System32" / L"wscript.exe") ||
                target == normalize_absolute_path(system / L"SysWOW64" / L"wscript.exe")) &&
            (_wcsicmp(args.c_str(), (L"\"" + launcher.wstring() + L"\"").c_str()) == 0 ||
             _wcsicmp(args.c_str(), launcher.c_str()) == 0);
    }

    void delete_pinned_store_shortcut(PinnedStoreShortcut& shortcut)
    {
        FILE_DISPOSITION_INFO disposition{ TRUE };
        if (!SetFileInformationByHandle(shortcut.file.get(), FileDispositionInfo, &disposition, sizeof(disposition)))
            throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Unable to retire the owned Memmy shortcut");
        shortcut.file.reset();
    }

    constexpr bool is_generated_store_shortcut_stem(std::wstring_view stem)
    {
        if (stem == L"Memmy" || stem == L"Memmy (Microsoft Store)") return true;
        const auto is_generated_number = [](std::wstring_view number) constexpr {
            // Generated suffixes are canonical decimal integers >= 2. Reject
            // signs, leading zeroes and extra text without integer overflow.
            if (number.empty() || number.front() < L'1' || number.front() > L'9') return false;
            for (const auto digit : number)
                if (digit < L'0' || digit > L'9') return false;
            return number.size() > 1 || number.front() >= L'2';
        };
        constexpr std::wstring_view store_prefix = L"Memmy (Microsoft Store ";
        if (stem.starts_with(store_prefix) && stem.ends_with(L")"))
            return is_generated_number(stem.substr(store_prefix.size(), stem.size() - store_prefix.size() - 1));
        constexpr std::wstring_view prefix = L"Memmy ";
        return stem.starts_with(prefix) && is_generated_number(stem.substr(prefix.size()));
    }

    void create_store_shortcut(const LegacyTransitionOptions& options)
    {
        require_allowed_memmy_package_identity(options);
        const auto package_path = store_shortcut_package_path(options);
        const auto local_app_data = store_shortcut_local_app_data();
        const auto icon = persist_store_shortcut_icon(options, package_path, local_app_data);
        const auto desktop = resolve_known_folder_path(FOLDERID_Desktop, L"Desktop directory is unavailable");
        com_ptr<IShellItem> apps_folder;
        check_hresult(SHGetKnownFolderItem(FOLDERID_AppsFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(apps_folder.put())));
        com_ptr<IShellItem> application;
        check_hresult(SHCreateItemFromRelativeName(apps_folder.get(), options.aumid.c_str(), nullptr, IID_PPV_ARGS(application.put())));
        StoreShortcutItemId item;
        check_hresult(SHGetIDListFromObject(application.get(), &item.value));
        if (!item.value) throw hresult_error(E_UNEXPECTED, L"Store application shell identity is empty");
        std::vector<std::wstring> legacy_executables;
        for (const auto key : { legacy_uninstall_key, legacy_installer_key })
            for (const auto view : { KEY_WOW64_32KEY, KEY_WOW64_64KEY })
            {
                const auto directory = read_current_user_registry_string(key, L"InstallLocation", view, "shortcut");
                if (directory && std::filesystem::path(*directory).is_absolute() && !is_windows_apps_path(*directory))
                    legacy_executables.push_back(normalize_absolute_path(std::filesystem::path(*directory) / L"Memmy.exe"));
            }
        const auto owned = [&](const PinnedStoreShortcut& shortcut) {
            return shortcut.link && store_shortcut_is_owned(shortcut.link.get(), item.value,
                options, package_path, local_app_data, legacy_executables);
        };
        std::filesystem::path published;
        for (int index = 0; index < 100; ++index)
        {
            const std::wstring name = index == 0 ? L"Memmy.lnk" : L"Memmy " + std::to_wstring(index + 1) + L".lnk";
            const auto target = desktop / name;
            auto existing = read_pinned_store_shortcut(target);
            if (std::filesystem::exists(target) && !owned(existing)) continue;
            if (existing.link && store_shortcut_has_identity(existing.link.get(), item.value))
            {
                std::vector<wchar_t> current_icon(32768);
                int icon_index = -1;
                if (SUCCEEDED(existing.link->GetIconLocation(current_icon.data(), static_cast<int>(current_icon.size()), &icon_index)) &&
                    current_icon[0] && icon_index == 0 && normalize_absolute_path(current_icon.data()) == normalize_absolute_path(icon))
                {
                    published = target;
                    break;
                }
            }
            com_ptr<IShellLinkW> link;
            check_hresult(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(link.put())));
            auto persist = link.as<IPersistFile>();
            check_hresult(link->SetIDList(item.value));
            check_hresult(link->SetDescription(L"Memmy"));
            check_hresult(link->SetIconLocation(icon.c_str(), 0));
            const auto temporary = desktop / (name + L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp");
            const HRESULT save_result = persist->Save(temporary.c_str(), TRUE);
            if (FAILED(save_result)) { DeleteFileW(temporary.c_str()); check_hresult(save_result); }
            try { if (owned(existing)) delete_pinned_store_shortcut(existing); }
            catch (...) { DeleteFileW(temporary.c_str()); throw; }
            // Never replace an uninspected file, even if it appeared after the
            // owned link was removed. A name collision moves on to Memmy 2, etc.
            if (MoveFileW(temporary.c_str(), target.c_str())) { published = target; break; }
            const auto error = GetLastError();
            DeleteFileW(temporary.c_str());
            if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) throw hresult_error(HRESULT_FROM_WIN32(error));
        }
        if (published.empty()) throw hresult_error(HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS), L"No free Memmy shortcut name");
        // Retire only proven Memmy links, including old Store-suffixed names,
        // after the replacement is durable. A filename alone is never authority.
        for (const auto& entry : std::filesystem::directory_iterator(desktop))
        {
            const auto path = entry.path();
            const auto stem = path.stem().wstring();
            if (path == published || _wcsicmp(path.extension().c_str(), L".lnk") != 0 ||
                !is_generated_store_shortcut_stem(stem)) continue;
            auto existing = read_pinned_store_shortcut(path);
            if (owned(existing)) delete_pinned_store_shortcut(existing);
        }
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, published.c_str(), nullptr);
        SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, desktop.c_str(), nullptr);
    }

    LegacySourceExecutableIdentity capture_source_executable_identity(const std::filesystem::path& executable_path);
    scoped_handle create_transition_mutation_mutex();
    std::wstring legacy_transition_cleanup_active_pipe_name();
    HANDLE create_user_restricted_pipe(const std::wstring& pipe_name, DWORD open_mode, DWORD maximum_instances);
    std::filesystem::path legacy_cleanup_journal_path();

    std::wstring discovered_install_fingerprint(const std::filesystem::path& install)
    {
        const auto value = capture_source_executable_identity(install / L"Memmy.exe");
        std::wostringstream text;
        text << std::hex << value.volume_serial_number << L":" << value.file_index << L":"
             << value.file_size << L":" << value.last_write_time;
        return text.str();
    }

    // Refuse junction/short-name aliases before a recursive install cleanup. Ordinary
    // installations already use the final DOS path recorded by NSIS.
    void require_direct_install_path(const std::filesystem::path& install)
    {
        scoped_handle directory(CreateFileW(install.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        if (!directory) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Cannot inspect the legacy install path");
        std::vector<wchar_t> final_path(32768);
        const DWORD size = GetFinalPathNameByHandleW(directory.get(), final_path.data(), static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (size == 0 || size >= final_path.size()) throw hresult_error(E_ACCESSDENIED, L"Cannot resolve the real legacy install path");
        std::wstring resolved(final_path.data(), size);
        if (resolved.rfind(L"\\\\?\\", 0) == 0) resolved.erase(0, 4);
        if (normalize_absolute_path(resolved) != normalize_absolute_path(install))
            throw hresult_error(E_ACCESSDENIED, L"Legacy install path is an alias; automatic cleanup skipped");
    }

    void emit_discovered_legacy_installation()
    {
        auto directory = read_current_user_registry_string(legacy_uninstall_key, L"InstallLocation", KEY_WOW64_64KEY, "64-bit");
        if (!directory) directory = read_current_user_registry_string(legacy_uninstall_key, L"InstallLocation", KEY_WOW64_32KEY, "32-bit");
        if (!directory) directory = read_current_user_registry_string(legacy_installer_key, L"InstallLocation", KEY_WOW64_64KEY, "64-bit");
        if (!directory) directory = read_current_user_registry_string(legacy_installer_key, L"InstallLocation", KEY_WOW64_32KEY, "32-bit");
        if (!directory) { std::cout << "null\n"; return; }
        const std::filesystem::path install(*directory);
        if (!install.is_absolute() || install == install.root_path() || is_windows_apps_path(install))
            throw hresult_invalid_argument(L"Legacy installation directory is unsafe");
        const auto version = read_current_user_registry_string(legacy_uninstall_key, L"DisplayVersion", KEY_WOW64_64KEY, "64-bit");
        std::wstring fingerprint;
        try { fingerprint = discovered_install_fingerprint(install); } catch (...) { /* Data discovery also works after uninstall. */ }
        std::cout << "{\"installDirectory\":\"" << escape_json(utf8(install.wstring())) << "\",\"appVersion\":\""
                  << escape_json(utf8(version.value_or(L"0.0.0"))) << "\",\"fingerprint\":\"" << escape_json(utf8(fingerprint)) << "\"}\n";
    }

    // Explorer supplies an ordinary current-user process and registry context. Merely
    // starting an external EXE as a child of the package can retain virtualization.
    void launch_discovered_legacy_cleanup(const LegacyTransitionOptions& options)
    {
        validate_legacy_transition_options(options, true, true);
        require_allowed_memmy_package_identity(options);
        com_ptr<IShellWindows> windows;
        check_hresult(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(windows.put())));
        VARIANT location{}; location.vt = VT_I4; location.lVal = CSIDL_DESKTOP;
        VARIANT empty{};
        long hwnd = 0;
        com_ptr<IDispatch> desktop;
        check_hresult(windows->FindWindowSW(&location, &empty, SWC_DESKTOP, &hwnd, SWFO_NEEDDISPATCH, desktop.put()));
        com_ptr<IShellBrowser> browser;
        check_hresult(desktop.as<::IServiceProvider>()->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(browser.put())));
        com_ptr<IShellView> view;
        check_hresult(browser->QueryActiveShellView(view.put()));
        com_ptr<IDispatch> background;
        check_hresult(view->GetItemObject(SVGIO_BACKGROUND, IID_PPV_ARGS(background.put())));
        com_ptr<IDispatch> application;
        check_hresult(background.as<IShellFolderViewDual>()->get_Application(application.put()));
        const auto command = build_legacy_cleanup_arguments(options.external_helper_path, L"run-discovered-legacy-cleanup", options, true);
        std::wstring arguments;
        for (size_t index = 1; index < command.size(); ++index) {
            if (!arguments.empty()) arguments += L" ";
            arguments += quote_command_line_argument(command[index]);
        }
        struct AutoVariant { VARIANT value{}; ~AutoVariant() { VariantClear(&value); } } file, args;
        file.value.vt = VT_BSTR; file.value.bstrVal = SysAllocString(options.external_helper_path.c_str());
        args.value.vt = VT_BSTR; args.value.bstrVal = SysAllocString(arguments.c_str());
        if (!file.value.bstrVal || !args.value.bstrVal) throw hresult_error(E_OUTOFMEMORY);
        VARIANT show{}; show.vt = VT_I4; show.lVal = SW_HIDE;
        check_hresult(application.as<IShellDispatch2>()->ShellExecute(file.value.bstrVal, args.value, empty, empty, show));
    }

    void run_discovered_legacy_cleanup(const LegacyTransitionOptions& options)
    {
        validate_legacy_transition_options(options, true, true);
        require_allowed_memmy_package_identity(options);
        if (current_process_has_package_identity() ||
            normalize_absolute_path(current_executable_path()) != normalize_absolute_path(options.external_helper_path))
            throw hresult_error(E_ACCESSDENIED, L"Independent cleanup requires the fixed unpackaged helper");
        const auto receipt = options.external_helper_path.parent_path() / (L"cleanup-" + options.attempt_id + L".json");
        try
        {
            scoped_handle cleanup_active(create_user_restricted_pipe(legacy_transition_cleanup_active_pipe_name(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, 1));
            if (!cleanup_active) throw hresult_error(HRESULT_FROM_WIN32(ERROR_BUSY), L"Another legacy cleanup is active");
            auto mutex = create_transition_mutation_mutex();
            scoped_mutex_ownership ownership;
            ownership.acquire(mutex.get());
            if (registered_package_full_names(options.package_family_name).empty())
                throw hresult_error(E_ACCESSDENIED, L"Store package is no longer registered");
            if (std::filesystem::exists(legacy_cleanup_journal_path()))
                throw hresult_error(E_ACCESSDENIED, L"A compatible cleanup journal requires broker recovery");
            require_direct_install_path(options.legacy_install_directory);
            if (options.legacy_install_fingerprint.empty() ||
                discovered_install_fingerprint(options.legacy_install_directory) != options.legacy_install_fingerprint)
                throw hresult_error(E_ACCESSDENIED, L"Legacy installation changed after data discovery");
            const auto user_home = resolve_known_folder_path(FOLDERID_Profile, L"User profile is unavailable");
            const auto drive = options.legacy_install_directory.root_path();
            if (paths_overlap(options.legacy_install_directory, user_home / L".memmy") ||
                paths_overlap(options.legacy_install_directory, drive / L"MemmyData" / L".memmy"))
                throw hresult_error(E_ACCESSDENIED, L"Legacy installation overlaps retained user data");
            initialize_legacy_cleanup_diagnostics(options, "discovered-unpackaged-helper");
            if (!stop_legacy_for_data_import()) throw hresult_error(HRESULT_FROM_WIN32(ERROR_BUSY), L"Legacy Memmy could not be closed");
            require_direct_install_path(options.legacy_install_directory);
            if (discovered_install_fingerprint(options.legacy_install_directory) != options.legacy_install_fingerprint)
                throw hresult_error(E_ACCESSDENIED, L"Legacy installation changed while closing processes");
            finalize_legacy_cleanup_unpacked(options, false, true);
            write_text_file_atomic(receipt, "{\"status\":\"cleaned\"}\n");
        }
        catch (...)
        {
            write_text_file_atomic(receipt, "{\"status\":\"failed\"}\n");
            throw;
        }
    }

    std::wstring process_application_user_model_id(HANDLE process)
    {
        UINT32 length = 0;
        LONG result = GetApplicationUserModelId(process, &length, nullptr);
        if (result != ERROR_INSUFFICIENT_BUFFER || length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to size a process application user model ID");
        }
        std::vector<wchar_t> value(length);
        result = GetApplicationUserModelId(process, &length, value.data());
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read a process application user model ID");
        }
        return std::wstring(value.data());
    }

    std::filesystem::path process_image_path(HANDLE process)
    {
        std::vector<wchar_t> value(32768);
        DWORD length = static_cast<DWORD>(value.size());
        if (!QueryFullProcessImageNameW(process, 0, value.data(), &length) || length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve a process image path");
        }
        return std::filesystem::path(std::wstring(value.data(), length));
    }

    DWORD current_parent_process_id()
    {
        scoped_handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
        if (!snapshot)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to inspect the cleanup broker parent process");
        }
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        if (!Process32FirstW(snapshot.get(), &entry))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to enumerate the cleanup broker parent process");
        }
        do
        {
            if (entry.th32ProcessID == GetCurrentProcessId())
            {
                return entry.th32ParentProcessID;
            }
        } while (Process32NextW(snapshot.get(), &entry));
        throw hresult_error(E_UNEXPECTED, L"Cleanup broker process is absent from the process snapshot");
    }

    void validate_cleanup_broker_parent_process(
        const std::wstring& expected_user_sid,
        DWORD expected_session_id)
    {
        const DWORD parent_process_id = current_parent_process_id();
        scoped_handle parent(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            parent_process_id));
        if (!parent)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open the cleanup broker parent process");
        }
        DWORD parent_session_id = 0;
        if (!ProcessIdToSessionId(parent_process_id, &parent_session_id))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve the cleanup broker parent session");
        }
        if (parent_session_id != expected_session_id ||
            _wcsicmp(process_user_sid(parent.get()).c_str(), expected_user_sid.c_str()) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker parent does not belong to the current user and session");
        }
        if (process_package_family(parent.get()))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker must be created by an unpackaged parent process");
        }
    }

    std::filesystem::path legacy_cleanup_broker_directory()
    {
        return resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for the cleanup broker") /
            L"Memmy" / L"store-transition" / L"broker";
    }

    std::filesystem::path legacy_cleanup_broker_executable_path()
    {
        return legacy_cleanup_broker_directory() / L"MemmyStoreUpdate.exe";
    }

    void validate_or_create_plain_directory(
        const std::filesystem::path& path,
        bool allow_create)
    {
        DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES && allow_create)
        {
            const DWORD inspect_error = GetLastError();
            if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(inspect_error),
                    L"Unable to inspect a cleanup broker directory");
            }
            if (!CreateDirectoryW(path.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to create a cleanup broker directory");
            }
            attributes = GetFileAttributesW(path.c_str());
        }
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED)) != 0)
        {
            throw hresult_invalid_argument(
                L"Cleanup broker directory is missing, unsafe, encrypted, or a reparse point");
        }
    }

    void validate_cleanup_broker_directory_chain(bool allow_create)
    {
        const std::filesystem::path local_app_data = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for the cleanup broker");
        if (!local_app_data.is_absolute() ||
            normalize_absolute_path(local_app_data) == normalize_absolute_path(local_app_data.root_path()))
        {
            throw hresult_invalid_argument(L"LOCALAPPDATA is unsafe for the cleanup broker");
        }
        validate_or_create_plain_directory(local_app_data, false);
        validate_or_create_plain_directory(local_app_data / L"Memmy", allow_create);
        validate_or_create_plain_directory(
            local_app_data / L"Memmy" / L"store-transition",
            allow_create);
        validate_or_create_plain_directory(legacy_cleanup_broker_directory(), allow_create);
    }

    void validate_cleanup_broker_executable()
    {
        validate_cleanup_broker_directory_chain(false);
        const std::filesystem::path expected_path = legacy_cleanup_broker_executable_path();
        if (normalize_absolute_path(current_executable_path()) != normalize_absolute_path(expected_path))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker is not running from its fixed staged path");
        }
        const DWORD attributes = GetFileAttributesW(expected_path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
                FILE_ATTRIBUTE_ENCRYPTED)) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker executable is not a plain unencrypted file");
        }
    }

    void initialize_cleanup_broker_startup_diagnostics()
    {
        LegacyCleanupDiagnostics diagnostics;
        diagnostics.directory_path = legacy_cleanup_broker_directory();
        diagnostics.log_path = diagnostics.directory_path /
            (L"broker-startup-" + std::to_wstring(GetCurrentProcessId()) + L".jsonl");
        diagnostics.process_role = "native-cleanup-broker-startup";
        diagnostics.failure_process_role = diagnostics.process_role;
        diagnostics.transition_id = "broker-startup";
        diagnostics.attempt_id = "broker-startup";
        diagnostics.process_id = GetCurrentProcessId();
        diagnostics.session_id_available = ProcessIdToSessionId(
            diagnostics.process_id,
            &diagnostics.session_id) != FALSE;
        UINT32 package_name_length = 0;
        diagnostics.package_identity_result = GetCurrentPackageFullName(
            &package_name_length,
            nullptr);
        if (diagnostics.package_identity_result == ERROR_INSUFFICIENT_BUFFER &&
            package_name_length > 0)
        {
            std::vector<wchar_t> package_name(package_name_length);
            diagnostics.package_identity_result = GetCurrentPackageFullName(
                &package_name_length,
                package_name.data());
            if (diagnostics.package_identity_result == ERROR_SUCCESS)
            {
                diagnostics.has_package_identity = true;
                diagnostics.package_full_name = utf8(std::wstring(package_name.data()));
            }
        }
        diagnostics.current_operation = "broker-startup-attestation";
        diagnostics.current_target = utf8(current_executable_path().wstring());
        legacy_cleanup_diagnostics = std::move(diagnostics);
        if (!append_legacy_cleanup_diagnostic(
                "process-context",
                "started",
                "broker-startup-attestation",
                utf8(current_executable_path().wstring())))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                L"Unable to initialize the fixed cleanup broker startup diagnostic log");
        }
    }

    std::optional<std::wstring> read_authority_registry_value(
        HKEY root,
        const std::wstring& user_sid,
        const wchar_t* key_path,
        REGSAM view_access,
        const std::string& root_name,
        const std::string& view_name)
    {
        const std::wstring resolved_key_path = root == HKEY_USERS
            ? user_sid + L"\\" + key_path
            : std::wstring(key_path);
        HKEY raw_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            root,
            resolved_key_path.c_str(),
            0,
            KEY_QUERY_VALUE | view_access,
            &raw_key);
        append_legacy_cleanup_diagnostic(
            "broker-authority-attestation",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "missing"
                    : "error"),
            "RegOpenKeyExW(authority-attestation)",
            root_name + "\\" + utf8(key_path) + "\\InstallLocation",
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=" + view_name);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (open_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                L"Unable to open the cleanup broker installation authority");
        }
        scoped_registry_key key(raw_key);
        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(
            key.get(),
            L"InstallLocation",
            nullptr,
            &type,
            nullptr,
            &bytes);
        if (result == ERROR_FILE_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (result != ERROR_SUCCESS ||
            (type != REG_SZ && type != REG_EXPAND_SZ) ||
            bytes < sizeof(wchar_t) ||
            bytes > 65536)
        {
            throw hresult_error(
                result == ERROR_SUCCESS ? E_INVALIDARG : HRESULT_FROM_WIN32(result),
                L"Cleanup broker installation authority has an invalid value");
        }
        std::vector<wchar_t> value((bytes / sizeof(wchar_t)) + 1, L'\0');
        result = RegQueryValueExW(
            key.get(),
            L"InstallLocation",
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the cleanup broker installation authority");
        }
        if (value[0] == L'\0')
        {
            throw hresult_invalid_argument(L"Cleanup broker installation authority is empty");
        }
        return std::wstring(value.data());
    }

    void require_matching_authority_views(
        const std::optional<std::wstring>& current_user_value,
        const std::optional<std::wstring>& explicit_user_value)
    {
        if (current_user_value.has_value() != explicit_user_value.has_value() ||
            (current_user_value &&
             normalize_absolute_path(*current_user_value) !=
                normalize_absolute_path(*explicit_user_value)))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"HKCU and explicit HKEY_USERS cleanup authorities do not agree");
        }
    }

    LegacySourceExecutableIdentity capture_source_executable_identity(
        const std::filesystem::path& executable_path)
    {
        scoped_handle executable(CreateFileW(
            executable_path.c_str(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            nullptr));
        if (!executable)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open the legacy executable for generation attestation");
        }
        BY_HANDLE_FILE_INFORMATION information{};
        if (!GetFileInformationByHandle(executable.get(), &information))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to read the legacy executable generation identity");
        }
        if ((information.dwFileAttributes &
             (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Legacy executable generation identity resolved to an unsafe object");
        }
        return LegacySourceExecutableIdentity{
            information.dwVolumeSerialNumber,
            (static_cast<uint64_t>(information.nFileIndexHigh) << 32) |
                information.nFileIndexLow,
            (static_cast<uint64_t>(information.nFileSizeHigh) << 32) |
                information.nFileSizeLow,
            (static_cast<uint64_t>(information.ftLastWriteTime.dwHighDateTime) << 32) |
                information.ftLastWriteTime.dwLowDateTime
        };
    }

    bool source_executable_identities_match(
        const LegacySourceExecutableIdentity& first,
        const LegacySourceExecutableIdentity& second)
    {
        return first.volume_serial_number == second.volume_serial_number &&
            first.file_index == second.file_index &&
            first.file_size == second.file_size &&
            first.last_write_time == second.last_write_time;
    }

    void verify_source_executable_generation(
        const LegacyAuthorityCapture& capture,
        bool allow_missing_after_prepared_cleanup)
    {
        const std::filesystem::path executable_path =
            capture.install_directory / L"Memmy.exe";
        const DWORD attributes = GetFileAttributesW(executable_path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
            {
                if (!capture.source_executable_identity)
                {
                    if (path_is_missing(capture.install_directory))
                    {
                        return;
                    }
                    throw hresult_error(
                        E_ACCESSDENIED,
                        L"A legacy install directory appeared after residue-only authority capture");
                }
                if (allow_missing_after_prepared_cleanup)
                {
                    return;
                }
            }
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Legacy executable generation identity is no longer available");
        }
        if (!capture.source_executable_identity)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"A legacy executable appeared after residue-only authority capture");
        }
        const LegacySourceExecutableIdentity current_identity =
            capture_source_executable_identity(executable_path);
        if (!source_executable_identities_match(
                *capture.source_executable_identity,
                current_identity))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Legacy executable generation changed after broker authority capture");
        }
    }

    LegacyAuthorityCapture capture_legacy_cleanup_authority()
    {
        LegacyAuthorityCapture capture;
        capture.user_sid = current_user_sid();
        capture.session_id = current_process_session_id();
        const auto read_pair = [&](const wchar_t* key_path, REGSAM view, const std::string& view_name)
        {
            const auto current_user_value = read_authority_registry_value(
                HKEY_CURRENT_USER,
                capture.user_sid,
                key_path,
                view,
                "HKCU",
                view_name);
            const auto explicit_user_value = read_authority_registry_value(
                HKEY_USERS,
                capture.user_sid,
                key_path,
                view,
                "HKU\\" + utf8(capture.user_sid),
                view_name);
            require_matching_authority_views(current_user_value, explicit_user_value);
            return current_user_value;
        };
        capture.installer_32 = read_pair(legacy_installer_key, KEY_WOW64_32KEY, "32-bit");
        capture.installer_64 = read_pair(legacy_installer_key, KEY_WOW64_64KEY, "64-bit");
        capture.uninstall_32 = read_pair(legacy_uninstall_key, KEY_WOW64_32KEY, "32-bit");
        capture.uninstall_64 = read_pair(legacy_uninstall_key, KEY_WOW64_64KEY, "64-bit");

        if (!capture.installer_32 && !capture.installer_64)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker could not capture a fixed legacy installer authority");
        }
        const std::optional<std::wstring>* values[] = {
            &capture.installer_32,
            &capture.installer_64,
            &capture.uninstall_32,
            &capture.uninstall_64
        };
        const std::wstring canonical_install_directory = normalize_absolute_path(
            capture.installer_32 ? *capture.installer_32 : *capture.installer_64);
        for (const auto* value : values)
        {
            if (*value && normalize_absolute_path(**value) != canonical_install_directory)
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup authority views disagree about the install directory");
            }
        }
        capture.install_directory = capture.installer_32
            ? std::filesystem::path(*capture.installer_32)
            : std::filesystem::path(*capture.installer_64);
        LegacyTransitionOptions validation_options;
        validation_options.legacy_install_directory = capture.install_directory;
        validation_options.legacy_executable_path = capture.install_directory / L"Memmy.exe";
        const bool captured_install_exists = validate_legacy_install_authority(
            validation_options.legacy_install_directory,
            validation_options.legacy_executable_path);
        if (!captured_install_exists && !path_is_missing(capture.install_directory))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker residue authority has an ambiguous installation path");
        }
        if (captured_install_exists)
        {
            capture.source_executable_identity = capture_source_executable_identity(
                validation_options.legacy_executable_path);
        }
        append_legacy_cleanup_diagnostic(
            "broker-authority-attestation",
            captured_install_exists ? "installed-source-captured" : "residue-only-captured",
            "capture-native-authority",
            utf8(capture.install_directory.wstring()),
            std::nullopt,
            S_OK,
            std::string("installDirectoryExists=") +
                (captured_install_exists ? "true" : "false") +
                "; executableGenerationCaptured=" +
                (capture.source_executable_identity ? "true" : "false"));
        return capture;
    }

    void verify_legacy_cleanup_authority_unchanged(const LegacyAuthorityCapture& capture)
    {
        const auto verify_pair = [&](const wchar_t* key_path,
                                     REGSAM view,
                                     const std::string& view_name,
                                     const std::optional<std::wstring>& expected)
        {
            const auto current_user_value = read_authority_registry_value(
                HKEY_CURRENT_USER,
                capture.user_sid,
                key_path,
                view,
                "HKCU",
                view_name);
            const auto explicit_user_value = read_authority_registry_value(
                HKEY_USERS,
                capture.user_sid,
                key_path,
                view,
                "HKU\\" + utf8(capture.user_sid),
                view_name);
            require_matching_authority_views(current_user_value, explicit_user_value);
            if (current_user_value.has_value() != expected.has_value() ||
                (current_user_value &&
                 normalize_absolute_path(*current_user_value) != normalize_absolute_path(*expected)))
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup authority changed after the broker captured it");
            }
        };
        verify_pair(legacy_installer_key, KEY_WOW64_32KEY, "32-bit", capture.installer_32);
        verify_pair(legacy_installer_key, KEY_WOW64_64KEY, "64-bit", capture.installer_64);
        verify_pair(legacy_uninstall_key, KEY_WOW64_32KEY, "32-bit", capture.uninstall_32);
        verify_pair(legacy_uninstall_key, KEY_WOW64_64KEY, "64-bit", capture.uninstall_64);
        verify_source_executable_generation(capture, false);
    }

    std::string sha256_hex(const std::string& value)
    {
        HCRYPTPROV provider = 0;
        if (!CryptAcquireContextW(
                &provider,
                nullptr,
                MS_ENH_RSA_AES_PROV_W,
                PROV_RSA_AES,
                CRYPT_VERIFYCONTEXT))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to initialize cleanup marker hashing");
        }
        HCRYPTHASH hash = 0;
        if (!CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash))
        {
            const DWORD error = GetLastError();
            CryptReleaseContext(provider, 0);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to create a cleanup marker hash");
        }
        if (value.size() > (std::numeric_limits<DWORD>::max)() ||
            !CryptHashData(
                hash,
                reinterpret_cast<const BYTE*>(value.data()),
                static_cast<DWORD>(value.size()),
                0))
        {
            const DWORD error = value.size() > (std::numeric_limits<DWORD>::max)()
                ? ERROR_BUFFER_OVERFLOW
                : GetLastError();
            CryptDestroyHash(hash);
            CryptReleaseContext(provider, 0);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to hash the cleanup marker state path");
        }
        std::array<BYTE, 32> digest{};
        DWORD digest_bytes = static_cast<DWORD>(digest.size());
        if (!CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &digest_bytes, 0) ||
            digest_bytes != digest.size())
        {
            const DWORD error = GetLastError();
            CryptDestroyHash(hash);
            CryptReleaseContext(provider, 0);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to read the cleanup marker hash");
        }
        CryptDestroyHash(hash);
        CryptReleaseContext(provider, 0);
        std::ostringstream output;
        output << std::hex << std::setfill('0');
        for (const BYTE byte : digest)
        {
            output << std::setw(2) << static_cast<unsigned int>(byte);
        }
        return output.str();
    }

    std::wstring normalize_source_lease_state_path_for_hash(
        const std::filesystem::path& path)
    {
        const DWORD required_length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
        if (required_length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize the cleanup coordination state path");
        }
        std::vector<wchar_t> value(required_length);
        if (GetFullPathNameW(
                path.c_str(),
                required_length,
                value.data(),
                nullptr) == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize the cleanup coordination state path");
        }
        std::wstring normalized(value.data());
        std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
        while (normalized.size() > 3 && normalized.back() == L'\\')
        {
            normalized.pop_back();
        }
        for (wchar_t& character : normalized)
        {
            if (character >= L'A' && character <= L'Z')
            {
                character = static_cast<wchar_t>(character + (L'a' - L'A'));
            }
        }
        return normalized;
    }

    std::wstring legacy_transition_source_lease_pipe_name()
    {
        const std::filesystem::path state_path = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for cleanup coordination") /
            L"Memmy" / L"store-transition" / L"active.json";
        const std::string digest = sha256_hex(
            utf8(normalize_source_lease_state_path_for_hash(state_path)));
        return L"\\\\.\\pipe\\LOCAL\\memmy-store-transition-source-" +
            std::wstring(digest.begin(), digest.end());
    }

    std::wstring legacy_transition_cleanup_active_pipe_name()
    {
        return legacy_transition_source_lease_pipe_name() + L"-cleanup-active";
    }

    std::wstring legacy_cleanup_broker_pipe_name()
    {
        return L"\\\\.\\pipe\\LOCAL\\memmy-store-transition-cleanup-broker-v1-" +
            std::to_wstring(current_process_session_id());
    }

    HANDLE create_user_restricted_pipe(
        const std::wstring& pipe_name,
        DWORD open_mode,
        DWORD maximum_instances)
    {
        const std::wstring sid = current_user_sid();
        const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + sid + L")";
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(),
                SDDL_REVISION_1,
                &descriptor,
                nullptr))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to create the cleanup broker pipe security descriptor");
        }
        SECURITY_ATTRIBUTES security_attributes{};
        security_attributes.nLength = sizeof(security_attributes);
        security_attributes.lpSecurityDescriptor = descriptor;
        security_attributes.bInheritHandle = FALSE;
        const HANDLE pipe = CreateNamedPipeW(
            pipe_name.c_str(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            maximum_instances,
            262144,
            262144,
            5000,
            &security_attributes);
        const DWORD error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
        LocalFree(descriptor);
        if (pipe == INVALID_HANDLE_VALUE)
        {
            SetLastError(error);
        }
        return pipe;
    }

    bool exclusive_pipe_name_is_owned(const std::wstring& pipe_name)
    {
        scoped_handle probe(create_user_restricted_pipe(
            pipe_name,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            1));
        if (probe)
        {
            return false;
        }
        const DWORD error = GetLastError();
        if (error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY)
        {
            return true;
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(error),
            L"Unable to inspect a Store transition coordination pipe");
    }

    constexpr uint32_t legacy_cleanup_broker_magic = 0x42434D4D;
    constexpr uint32_t legacy_cleanup_broker_protocol_version = 1;
    constexpr uint32_t legacy_cleanup_broker_maximum_payload_bytes = 262144;
    constexpr uint32_t legacy_cleanup_broker_maximum_string_bytes = 65536;

    void write_handle_exact(HANDLE handle, const void* buffer, size_t bytes)
    {
        const auto* cursor = static_cast<const unsigned char*>(buffer);
        while (bytes > 0)
        {
            const DWORD chunk = static_cast<DWORD>(std::min<size_t>(
                bytes,
                (std::numeric_limits<DWORD>::max)()));
            DWORD written = 0;
            if (!WriteFile(handle, cursor, chunk, &written, nullptr) || written == 0)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to write a cleanup broker protocol frame");
            }
            cursor += written;
            bytes -= written;
        }
    }

    void read_handle_exact(HANDLE handle, void* buffer, size_t bytes)
    {
        auto* cursor = static_cast<unsigned char*>(buffer);
        while (bytes > 0)
        {
            const DWORD chunk = static_cast<DWORD>(std::min<size_t>(
                bytes,
                (std::numeric_limits<DWORD>::max)()));
            DWORD read = 0;
            if (!ReadFile(handle, cursor, chunk, &read, nullptr) || read == 0)
            {
                const DWORD error = GetLastError();
                throw hresult_error(
                    HRESULT_FROM_WIN32(error == ERROR_SUCCESS ? ERROR_BROKEN_PIPE : error),
                    L"Unable to read a cleanup broker protocol frame");
            }
            cursor += read;
            bytes -= read;
        }
    }

    void append_wire_u32(std::vector<unsigned char>& output, uint32_t value)
    {
        output.push_back(static_cast<unsigned char>(value & 0xff));
        output.push_back(static_cast<unsigned char>((value >> 8) & 0xff));
        output.push_back(static_cast<unsigned char>((value >> 16) & 0xff));
        output.push_back(static_cast<unsigned char>((value >> 24) & 0xff));
    }

    uint32_t read_wire_u32(
        const std::vector<unsigned char>& input,
        size_t& offset)
    {
        if (offset > input.size() || input.size() - offset < sizeof(uint32_t))
        {
            throw hresult_invalid_argument(L"Cleanup broker protocol integer is truncated");
        }
        const uint32_t value =
            static_cast<uint32_t>(input[offset]) |
            (static_cast<uint32_t>(input[offset + 1]) << 8) |
            (static_cast<uint32_t>(input[offset + 2]) << 16) |
            (static_cast<uint32_t>(input[offset + 3]) << 24);
        offset += sizeof(uint32_t);
        return value;
    }

    void append_wire_u64(std::vector<unsigned char>& output, uint64_t value)
    {
        append_wire_u32(output, static_cast<uint32_t>(value & 0xffffffffULL));
        append_wire_u32(output, static_cast<uint32_t>(value >> 32));
    }

    uint64_t read_wire_u64(
        const std::vector<unsigned char>& input,
        size_t& offset)
    {
        const uint64_t low = read_wire_u32(input, offset);
        const uint64_t high = read_wire_u32(input, offset);
        return low | (high << 32);
    }

    void append_wire_wstring(
        std::vector<unsigned char>& output,
        const std::wstring& value)
    {
        if (value.size() > legacy_cleanup_broker_maximum_string_bytes / sizeof(wchar_t))
        {
            throw hresult_invalid_argument(L"Cleanup broker protocol string is too long");
        }
        const uint32_t bytes = static_cast<uint32_t>(value.size() * sizeof(wchar_t));
        append_wire_u32(output, bytes);
        const auto* first = reinterpret_cast<const unsigned char*>(value.data());
        output.insert(output.end(), first, first + bytes);
    }

    std::wstring read_wire_wstring(
        const std::vector<unsigned char>& input,
        size_t& offset)
    {
        const uint32_t bytes = read_wire_u32(input, offset);
        if (bytes > legacy_cleanup_broker_maximum_string_bytes ||
            bytes % sizeof(wchar_t) != 0 ||
            offset > input.size() ||
            input.size() - offset < bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker protocol string is invalid");
        }
        std::wstring value(bytes / sizeof(wchar_t), L'\0');
        if (bytes != 0)
        {
            memcpy(value.data(), input.data() + offset, bytes);
        }
        offset += bytes;
        if (value.find(L'\0') != std::wstring::npos)
        {
            throw hresult_invalid_argument(L"Cleanup broker protocol string contains a null character");
        }
        return value;
    }

    void append_wire_string(
        std::vector<unsigned char>& output,
        const std::string& value)
    {
        if (value.size() > legacy_cleanup_broker_maximum_string_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker response string is too long");
        }
        append_wire_u32(output, static_cast<uint32_t>(value.size()));
        output.insert(output.end(), value.begin(), value.end());
    }

    std::string read_wire_string(
        const std::vector<unsigned char>& input,
        size_t& offset)
    {
        const uint32_t bytes = read_wire_u32(input, offset);
        if (bytes > legacy_cleanup_broker_maximum_string_bytes ||
            offset > input.size() ||
            input.size() - offset < bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker response string is invalid");
        }
        const auto* first = reinterpret_cast<const char*>(input.data() + offset);
        std::string value(first, first + bytes);
        offset += bytes;
        if (value.find('\0') != std::string::npos)
        {
            throw hresult_invalid_argument(L"Cleanup broker response string contains a null character");
        }
        return value;
    }

    std::vector<unsigned char> serialize_legacy_transition_options(
        const LegacyTransitionOptions& options)
    {
        std::vector<unsigned char> payload;
        append_wire_wstring(payload, options.external_helper_path.wstring());
        append_wire_wstring(payload, options.legacy_install_directory.wstring());
        append_wire_wstring(payload, options.legacy_executable_path.wstring());
        append_wire_wstring(payload, options.shortcut_path.wstring());
        append_wire_wstring(payload, options.aumid);
        append_wire_wstring(payload, options.package_family_name);
        append_wire_wstring(payload, options.transition_id);
        append_wire_wstring(payload, options.attempt_id);
        if (payload.size() > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker request exceeds its size limit");
        }
        return payload;
    }

    LegacyTransitionOptions deserialize_legacy_transition_options(
        const std::vector<unsigned char>& payload)
    {
        size_t offset = 0;
        LegacyTransitionOptions options;
        options.external_helper_path = read_wire_wstring(payload, offset);
        options.legacy_install_directory = read_wire_wstring(payload, offset);
        options.legacy_executable_path = read_wire_wstring(payload, offset);
        options.shortcut_path = read_wire_wstring(payload, offset);
        options.aumid = read_wire_wstring(payload, offset);
        options.package_family_name = read_wire_wstring(payload, offset);
        options.transition_id = read_wire_wstring(payload, offset);
        options.attempt_id = read_wire_wstring(payload, offset);
        if (offset != payload.size())
        {
            throw hresult_invalid_argument(L"Cleanup broker request has trailing data");
        }
        return options;
    }

    std::vector<unsigned char> serialize_broker_response(
        const LegacyCleanupBrokerResponse& response)
    {
        std::vector<unsigned char> payload;
        append_wire_u32(payload, static_cast<uint32_t>(response.hresult));
        append_wire_u32(payload, response.win32_error ? 1 : 0);
        append_wire_u32(payload, response.win32_error.value_or(ERROR_SUCCESS));
        append_wire_wstring(payload, response.transition_id);
        append_wire_wstring(payload, response.attempt_id);
        append_wire_string(payload, single_line(response.operation));
        append_wire_string(payload, single_line(response.target));
        append_wire_string(payload, single_line(response.message));
        if (payload.size() > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker response exceeds its size limit");
        }
        return payload;
    }

    LegacyCleanupBrokerResponse deserialize_broker_response(
        const std::vector<unsigned char>& payload)
    {
        size_t offset = 0;
        LegacyCleanupBrokerResponse response;
        response.hresult = static_cast<HRESULT>(read_wire_u32(payload, offset));
        const uint32_t has_win32_error = read_wire_u32(payload, offset);
        const DWORD win32_error = read_wire_u32(payload, offset);
        if (has_win32_error > 1)
        {
            throw hresult_invalid_argument(L"Cleanup broker response has an invalid error flag");
        }
        if (has_win32_error != 0)
        {
            response.win32_error = win32_error;
        }
        response.transition_id = read_wire_wstring(payload, offset);
        response.attempt_id = read_wire_wstring(payload, offset);
        response.operation = read_wire_string(payload, offset);
        response.target = read_wire_string(payload, offset);
        response.message = read_wire_string(payload, offset);
        if (offset != payload.size())
        {
            throw hresult_invalid_argument(L"Cleanup broker response has trailing data");
        }
        return response;
    }

    std::filesystem::path legacy_cleanup_journal_path()
    {
        return legacy_cleanup_broker_directory() / L"cleanup-journal-v1.bin";
    }

    void append_wire_optional_wstring(
        std::vector<unsigned char>& output,
        const std::optional<std::wstring>& value)
    {
        append_wire_u32(output, value ? 1 : 0);
        if (value)
        {
            append_wire_wstring(output, *value);
        }
    }

    std::optional<std::wstring> read_wire_optional_wstring(
        const std::vector<unsigned char>& input,
        size_t& offset)
    {
        const uint32_t present = read_wire_u32(input, offset);
        if (present > 1)
        {
            throw hresult_invalid_argument(L"Cleanup journal has an invalid optional-value flag");
        }
        return present == 0
            ? std::nullopt
            : std::optional<std::wstring>(read_wire_wstring(input, offset));
    }

    std::vector<unsigned char> serialize_cleanup_journal(
        const LegacyCleanupJournal& journal)
    {
        constexpr uint32_t journal_magic = 0x4A434D4D;
        constexpr uint32_t journal_version = 2;
        std::vector<unsigned char> result;
        append_wire_u32(result, journal_magic);
        append_wire_u32(result, journal_version);
        append_wire_u32(result, static_cast<uint32_t>(journal.phase));
        const std::vector<unsigned char> options = serialize_legacy_transition_options(
            journal.options);
        append_wire_u32(result, static_cast<uint32_t>(options.size()));
        result.insert(result.end(), options.begin(), options.end());
        append_wire_wstring(result, journal.authority.user_sid);
        append_wire_u32(result, journal.authority.session_id);
        append_wire_wstring(result, journal.authority.install_directory.wstring());
        append_wire_optional_wstring(result, journal.authority.installer_32);
        append_wire_optional_wstring(result, journal.authority.installer_64);
        append_wire_optional_wstring(result, journal.authority.uninstall_32);
        append_wire_optional_wstring(result, journal.authority.uninstall_64);
        append_wire_u32(
            result,
            journal.authority.source_executable_identity ? 1U : 0U);
        if (journal.authority.source_executable_identity)
        {
            const LegacySourceExecutableIdentity& identity =
                *journal.authority.source_executable_identity;
            append_wire_u32(result, identity.volume_serial_number);
            append_wire_u64(result, identity.file_index);
            append_wire_u64(result, identity.file_size);
            append_wire_u64(result, identity.last_write_time);
        }
        if (result.size() > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup journal exceeds its fixed size limit");
        }
        return result;
    }

    LegacyCleanupJournal deserialize_cleanup_journal(
        const std::vector<unsigned char>& input)
    {
        constexpr uint32_t journal_magic = 0x4A434D4D;
        constexpr uint32_t journal_version = 2;
        size_t offset = 0;
        if (read_wire_u32(input, offset) != journal_magic ||
            read_wire_u32(input, offset) != journal_version)
        {
            throw hresult_invalid_argument(L"Cleanup journal header is invalid");
        }
        const uint32_t phase = read_wire_u32(input, offset);
        if (phase != static_cast<uint32_t>(LegacyCleanupJournalPhase::Prepared) &&
            phase != static_cast<uint32_t>(LegacyCleanupJournalPhase::Complete) &&
            phase != static_cast<uint32_t>(LegacyCleanupJournalPhase::Acknowledged))
        {
            throw hresult_invalid_argument(L"Cleanup journal phase is invalid");
        }
        LegacyCleanupJournal journal;
        journal.phase = static_cast<LegacyCleanupJournalPhase>(phase);
        const uint32_t options_bytes = read_wire_u32(input, offset);
        if (options_bytes > legacy_cleanup_broker_maximum_payload_bytes ||
            offset > input.size() ||
            input.size() - offset < options_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup journal options are invalid");
        }
        std::vector<unsigned char> options(
            input.begin() + offset,
            input.begin() + offset + options_bytes);
        offset += options_bytes;
        journal.options = deserialize_legacy_transition_options(options);
        journal.authority.user_sid = read_wire_wstring(input, offset);
        journal.authority.session_id = read_wire_u32(input, offset);
        journal.authority.install_directory = read_wire_wstring(input, offset);
        journal.authority.installer_32 = read_wire_optional_wstring(input, offset);
        journal.authority.installer_64 = read_wire_optional_wstring(input, offset);
        journal.authority.uninstall_32 = read_wire_optional_wstring(input, offset);
        journal.authority.uninstall_64 = read_wire_optional_wstring(input, offset);
        const uint32_t has_source_executable_identity = read_wire_u32(input, offset);
        if (has_source_executable_identity > 1)
        {
            throw hresult_invalid_argument(
                L"Cleanup journal has an invalid executable-generation flag");
        }
        if (has_source_executable_identity != 0)
        {
            journal.authority.source_executable_identity = LegacySourceExecutableIdentity{
                read_wire_u32(input, offset),
                read_wire_u64(input, offset),
                read_wire_u64(input, offset),
                read_wire_u64(input, offset)
            };
        }
        if (offset != input.size())
        {
            throw hresult_invalid_argument(L"Cleanup journal has trailing data");
        }
        return journal;
    }

    void write_cleanup_journal_atomic(const LegacyCleanupJournal& journal)
    {
        validate_cleanup_broker_directory_chain(false);
        const std::filesystem::path target_path = legacy_cleanup_journal_path();
        const std::vector<unsigned char> contents = serialize_cleanup_journal(journal);
        const std::filesystem::path temporary_path = target_path.wstring() +
            L"." + std::to_wstring(GetCurrentProcessId()) +
            L"." + std::to_wstring(GetTickCount64()) + L".tmp";
        scoped_handle output(CreateFileW(
            temporary_path.c_str(),
            GENERIC_WRITE,
            0,
            nullptr,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
        if (!output)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to create the temporary cleanup journal");
        }
        try
        {
            write_handle_exact(output.get(), contents.data(), contents.size());
            if (!FlushFileBuffers(output.get()))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to flush the temporary cleanup journal");
            }
            output.reset();
            const DWORD attributes = GetFileAttributesW(temporary_path.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES ||
                (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
                    FILE_ATTRIBUTE_ENCRYPTED)) != 0)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_INVALID_DATA),
                    L"Temporary cleanup journal is not a plain unencrypted file");
            }
            if (!MoveFileExW(
                    temporary_path.c_str(),
                    target_path.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to atomically publish the cleanup journal");
            }
        }
        catch (...)
        {
            output.reset();
            DeleteFileW(temporary_path.c_str());
            throw;
        }
    }

    std::optional<LegacyCleanupJournal> read_cleanup_journal()
    {
        const std::filesystem::path path = legacy_cleanup_journal_path();
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
            {
                return std::nullopt;
            }
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to inspect the fixed cleanup journal");
        }
        validate_cleanup_broker_directory_chain(false);
        if ((attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
            FILE_ATTRIBUTE_ENCRYPTED)) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup journal is not a plain unencrypted file");
        }
        scoped_handle input(CreateFileW(
            path.c_str(),
            GENERIC_READ,
            FILE_SHARE_READ,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
        if (!input)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open the fixed cleanup journal");
        }
        LARGE_INTEGER size{};
        if (!GetFileSizeEx(input.get(), &size) ||
            size.QuadPart <= 0 ||
            size.QuadPart > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_INVALID_DATA),
                L"Cleanup journal has an invalid size");
        }
        std::vector<unsigned char> contents(static_cast<size_t>(size.QuadPart));
        read_handle_exact(input.get(), contents.data(), contents.size());
        return deserialize_cleanup_journal(contents);
    }

    void delete_cleanup_journal_file(const wchar_t* failure_message)
    {
        const std::filesystem::path journal_path = legacy_cleanup_journal_path();
        if (DeleteFileW(journal_path.c_str()))
        {
            return;
        }
        const DWORD error = GetLastError();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
        {
            throw hresult_error(HRESULT_FROM_WIN32(error), failure_message);
        }
    }

    bool equivalent_transition_options(
        const LegacyTransitionOptions& first,
        const LegacyTransitionOptions& second)
    {
        const auto equivalent_optional_path = [](const std::filesystem::path& left,
                                                 const std::filesystem::path& right)
        {
            if (left.empty() || right.empty())
            {
                return left.empty() && right.empty();
            }
            return normalize_absolute_path(left) == normalize_absolute_path(right);
        };
        // attempt_id is intentionally excluded: Store creates a fresh attempt for
        // each retry. The durable identity is the transaction, package, attested
        // source, and fixed Desktop shortcut policy; the response echoes the
        // caller's current attempt_id separately.
        return equivalent_optional_path(first.external_helper_path, second.external_helper_path) &&
            equivalent_optional_path(first.legacy_install_directory, second.legacy_install_directory) &&
            equivalent_optional_path(first.legacy_executable_path, second.legacy_executable_path) &&
            equivalent_optional_path(first.shortcut_path, second.shortcut_path) &&
            first.aumid == second.aumid &&
            first.package_family_name == second.package_family_name &&
            first.transition_id == second.transition_id;
    }

    void validate_persisted_authority_shape(
        const LegacyAuthorityCapture& authority,
        const LegacyTransitionOptions& options)
    {
        if (authority.user_sid.empty() ||
            _wcsicmp(authority.user_sid.c_str(), current_user_sid().c_str()) != 0 ||
            !authority.installer_32 && !authority.installer_64)
        {
            throw hresult_error(E_ACCESSDENIED, L"Cleanup journal authority identity is invalid");
        }
        const std::wstring canonical = normalize_absolute_path(authority.install_directory);
        if (!authority.install_directory.is_absolute() ||
            canonical == normalize_absolute_path(authority.install_directory.root_path()) ||
            is_windows_apps_path(authority.install_directory) ||
            normalize_absolute_path(options.legacy_install_directory) != canonical ||
            normalize_absolute_path(options.legacy_executable_path.parent_path()) != canonical ||
            _wcsicmp(options.legacy_executable_path.filename().c_str(), L"Memmy.exe") != 0)
        {
            throw hresult_error(E_ACCESSDENIED, L"Cleanup journal source authority is unsafe");
        }
        const std::filesystem::path store_control_directory = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for journal validation") /
            L"Memmy";
        if (paths_overlap(authority.install_directory, store_control_directory))
        {
            throw hresult_error(E_ACCESSDENIED, L"Cleanup journal source overlaps Store control data");
        }
        const std::optional<std::wstring>* values[] = {
            &authority.installer_32,
            &authority.installer_64,
            &authority.uninstall_32,
            &authority.uninstall_64
        };
        for (const auto* value : values)
        {
            if (*value && normalize_absolute_path(**value) != canonical)
            {
                throw hresult_error(E_ACCESSDENIED, L"Cleanup journal authority views disagree");
            }
        }
    }

    void verify_recoverable_authority_state(
        const LegacyAuthorityCapture& authority,
        const LegacyTransitionOptions& options)
    {
        validate_persisted_authority_shape(authority, options);
        const auto verify_pair = [&](const wchar_t* key_path,
                                     REGSAM view,
                                     const std::string& view_name,
                                     const std::optional<std::wstring>& expected)
        {
            const auto current_user_value = read_authority_registry_value(
                HKEY_CURRENT_USER,
                authority.user_sid,
                key_path,
                view,
                "HKCU",
                view_name);
            const auto explicit_user_value = read_authority_registry_value(
                HKEY_USERS,
                authority.user_sid,
                key_path,
                view,
                "HKU\\" + utf8(authority.user_sid),
                view_name);
            require_matching_authority_views(current_user_value, explicit_user_value);
            if (current_user_value &&
                (!expected ||
                 normalize_absolute_path(*current_user_value) != normalize_absolute_path(*expected)))
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Cleanup recovery found a registry authority not present in its prepared journal");
            }
        };
        verify_pair(legacy_installer_key, KEY_WOW64_32KEY, "32-bit", authority.installer_32);
        verify_pair(legacy_installer_key, KEY_WOW64_64KEY, "64-bit", authority.installer_64);
        verify_pair(legacy_uninstall_key, KEY_WOW64_32KEY, "32-bit", authority.uninstall_32);
        verify_pair(legacy_uninstall_key, KEY_WOW64_64KEY, "64-bit", authority.uninstall_64);
        const DWORD directory_attributes = GetFileAttributesW(authority.install_directory.c_str());
        if (directory_attributes != INVALID_FILE_ATTRIBUTES &&
            ((directory_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
             (directory_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup recovery source changed to an unsafe filesystem object");
        }
        if (directory_attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to inspect the cleanup recovery source");
            }
        }
        verify_source_executable_generation(authority, true);
    }

    void verify_complete_cleanup_postconditions(
        const LegacyAuthorityCapture& authority,
        const LegacyTransitionOptions& options)
    {
        validate_persisted_authority_shape(authority, options);
        const auto require_missing_pair = [&](const wchar_t* key_path,
                                              REGSAM view,
                                              const std::string& view_name)
        {
            const auto current_user_value = read_authority_registry_value(
                HKEY_CURRENT_USER,
                authority.user_sid,
                key_path,
                view,
                "HKCU",
                view_name);
            const auto explicit_user_value = read_authority_registry_value(
                HKEY_USERS,
                authority.user_sid,
                key_path,
                view,
                "HKU\\" + utf8(authority.user_sid),
                view_name);
            require_matching_authority_views(current_user_value, explicit_user_value);
            if (current_user_value)
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Completed cleanup proof was invalidated by a native registry authority");
            }
        };
        require_missing_pair(legacy_installer_key, KEY_WOW64_32KEY, "32-bit");
        require_missing_pair(legacy_installer_key, KEY_WOW64_64KEY, "64-bit");
        require_missing_pair(legacy_uninstall_key, KEY_WOW64_32KEY, "32-bit");
        require_missing_pair(legacy_uninstall_key, KEY_WOW64_64KEY, "64-bit");
        if (!path_is_missing(authority.install_directory))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Completed cleanup proof was invalidated by a native install directory");
        }
    }

    void validate_orphaned_cleanup_journal_for_native_install(
        const LegacyCleanupJournal& journal)
    {
        validate_legacy_transition_options(journal.options, true, false);
        if (!journal.options.external_helper_path.empty())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup journal contains a deprecated external helper path");
        }
        require_allowed_memmy_package_identity(journal.options);
        validate_persisted_authority_shape(journal.authority, journal.options);
        if (!registered_package_full_names(allowed_memmy_package_family).empty() ||
            !registered_package_full_names(allowed_memmy_agent_package_family).empty())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Refusing to retire a cleanup journal while a Memmy Store package remains registered");
        }
        if (journal.phase == LegacyCleanupJournalPhase::Acknowledged)
        {
            return;
        }
        // With the Store package unregistered, a currently valid native authority
        // and regular Memmy.exe are the safe orphan/reinstall boundary. Retiring
        // either Prepared or Complete prevents an old transaction from binding the
        // next NSIS-to-Store cycle.
        const LegacyAuthorityCapture current_authority = capture_legacy_cleanup_authority();
        const DWORD directory_attributes = GetFileAttributesW(
            current_authority.install_directory.c_str());
        const DWORD executable_attributes = GetFileAttributesW(
            (current_authority.install_directory / L"Memmy.exe").c_str());
        if (current_authority.install_directory.empty() ||
            directory_attributes == INVALID_FILE_ATTRIBUTES ||
            (directory_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) !=
                FILE_ATTRIBUTE_DIRECTORY ||
            executable_attributes == INVALID_FILE_ATTRIBUTES ||
            (executable_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Unable to retire an orphaned cleanup journal without a valid native installation");
        }
    }

    void retire_orphaned_cleanup_journal_for_native_install()
    {
        const auto journal = read_cleanup_journal();
        if (!journal)
        {
            return;
        }
        if (exclusive_pipe_name_is_owned(legacy_transition_cleanup_active_pipe_name()))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_BUSY),
                L"Refusing to retire a cleanup journal while native cleanup is active");
        }
        validate_orphaned_cleanup_journal_for_native_install(*journal);
        delete_cleanup_journal_file(
            L"Unable to retire the orphaned cleanup journal for a native installation");
    }

    void send_broker_frame(
        HANDLE pipe,
        LegacyCleanupBrokerMessage message,
        const std::vector<unsigned char>& payload)
    {
        if (payload.size() > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker frame exceeds its size limit");
        }
        std::array<uint32_t, 4> header{
            legacy_cleanup_broker_magic,
            legacy_cleanup_broker_protocol_version,
            static_cast<uint32_t>(message),
            static_cast<uint32_t>(payload.size())
        };
        write_handle_exact(pipe, header.data(), sizeof(header));
        if (!payload.empty())
        {
            write_handle_exact(pipe, payload.data(), payload.size());
        }
    }

    std::pair<LegacyCleanupBrokerMessage, std::vector<unsigned char>> receive_broker_frame(
        HANDLE pipe)
    {
        std::array<uint32_t, 4> header{};
        read_handle_exact(pipe, header.data(), sizeof(header));
        if (header[0] != legacy_cleanup_broker_magic ||
            header[1] != legacy_cleanup_broker_protocol_version ||
            header[3] > legacy_cleanup_broker_maximum_payload_bytes)
        {
            throw hresult_invalid_argument(L"Cleanup broker frame header is invalid");
        }
        const auto message = static_cast<LegacyCleanupBrokerMessage>(header[2]);
        if (message != LegacyCleanupBrokerMessage::Ping &&
            message != LegacyCleanupBrokerMessage::Cleanup &&
            message != LegacyCleanupBrokerMessage::Stop &&
            message != LegacyCleanupBrokerMessage::Acknowledge &&
            message != LegacyCleanupBrokerMessage::Response)
        {
            throw hresult_invalid_argument(L"Cleanup broker frame type is invalid");
        }
        std::vector<unsigned char> payload(header[3]);
        if (!payload.empty())
        {
            read_handle_exact(pipe, payload.data(), payload.size());
        }
        return { message, std::move(payload) };
    }

    void require_allowed_memmy_package_identity(const LegacyTransitionOptions& options)
    {
        if ((options.package_family_name != allowed_memmy_package_family &&
             options.package_family_name != allowed_memmy_agent_package_family) ||
            options.aumid != options.package_family_name + L"!Memmy")
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker request does not name an allowed Memmy package identity");
        }
    }

    DWORD named_pipe_client_process_id(HANDLE pipe)
    {
        ULONG process_id = 0;
        if (!GetNamedPipeClientProcessId(pipe, &process_id) || process_id == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to identify the cleanup broker client process");
        }
        return static_cast<DWORD>(process_id);
    }

    DWORD named_pipe_server_process_id(HANDLE pipe)
    {
        ULONG process_id = 0;
        if (!GetNamedPipeServerProcessId(pipe, &process_id) || process_id == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to identify the cleanup broker server process");
        }
        return static_cast<DWORD>(process_id);
    }

    scoped_handle open_verified_pipe_peer_process(
        DWORD process_id,
        const std::wstring& expected_user_sid,
        DWORD expected_session_id)
    {
        scoped_handle process(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id));
        if (!process)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open a cleanup broker pipe peer process");
        }
        DWORD session_id = 0;
        if (!ProcessIdToSessionId(process_id, &session_id))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve a cleanup broker pipe peer session");
        }
        if (session_id != expected_session_id ||
            _wcsicmp(process_user_sid(process.get()).c_str(), expected_user_sid.c_str()) != 0)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker pipe peer does not belong to the current user and session");
        }
        return process;
    }

    void validate_cleanup_broker_client(
        HANDLE pipe,
        const LegacyTransitionOptions& options,
        const LegacyAuthorityCapture& capture)
    {
        require_allowed_memmy_package_identity(options);
        const DWORD client_process_id = named_pipe_client_process_id(pipe);
        scoped_handle client = open_verified_pipe_peer_process(
            client_process_id,
            capture.user_sid,
            capture.session_id);
        const auto package_family = process_package_family(client.get());
        if (!package_family || *package_family != options.package_family_name ||
            process_application_user_model_id(client.get()) != options.aumid)
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker client package identity does not match its request");
        }
    }

    void validate_cleanup_broker_server(HANDLE pipe)
    {
        const DWORD server_process_id = named_pipe_server_process_id(pipe);
        scoped_handle server = open_verified_pipe_peer_process(
            server_process_id,
            current_user_sid(),
            current_process_session_id());
        if (normalize_absolute_path(process_image_path(server.get())) !=
                normalize_absolute_path(legacy_cleanup_broker_executable_path()) ||
            process_package_family(server.get()))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker server is not the expected staged native process");
        }
    }

    scoped_handle connect_to_cleanup_broker(DWORD timeout_milliseconds)
    {
        const std::wstring pipe_name = legacy_cleanup_broker_pipe_name();
        const ULONGLONG deadline = GetTickCount64() + timeout_milliseconds;
        while (true)
        {
            scoped_handle pipe(CreateFileW(
                pipe_name.c_str(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                nullptr,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                nullptr));
            if (pipe)
            {
                validate_cleanup_broker_server(pipe.get());
                return pipe;
            }
            const DWORD error = GetLastError();
            const ULONGLONG now = GetTickCount64();
            if (now >= deadline)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(
                        error == ERROR_FILE_NOT_FOUND || error == ERROR_PIPE_BUSY
                            ? ERROR_TIMEOUT
                            : error),
                    L"Unable to connect to the native legacy cleanup broker");
            }
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to open the native legacy cleanup broker pipe");
            }
            WaitNamedPipeW(pipe_name.c_str(), 100);
            Sleep(25);
        }
    }

    LegacyCleanupBrokerResponse request_cleanup_broker(
        LegacyCleanupBrokerMessage message,
        const LegacyTransitionOptions* options,
        DWORD timeout_milliseconds = 10000)
    {
        scoped_handle pipe = connect_to_cleanup_broker(timeout_milliseconds);
        const std::vector<unsigned char> payload = options == nullptr
            ? std::vector<unsigned char>{}
            : serialize_legacy_transition_options(*options);
        send_broker_frame(pipe.get(), message, payload);
        auto [response_message, response_payload] = receive_broker_frame(pipe.get());
        if (response_message != LegacyCleanupBrokerMessage::Response)
        {
            throw hresult_invalid_argument(L"Cleanup broker returned a non-response frame");
        }
        LegacyCleanupBrokerResponse response = deserialize_broker_response(response_payload);
        if (options != nullptr &&
            (response.transition_id != options->transition_id ||
             response.attempt_id != options->attempt_id))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker response does not match the transition request");
        }
        return response;
    }

    bool files_have_equal_bytes(
        const std::filesystem::path& first_path,
        const std::filesystem::path& second_path)
    {
        scoped_handle first(CreateFileW(
            first_path.c_str(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
        scoped_handle second(CreateFileW(
            second_path.c_str(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
        if (!first || !second)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to open cleanup broker files for byte verification");
        }
        LARGE_INTEGER first_size{};
        LARGE_INTEGER second_size{};
        if (!GetFileSizeEx(first.get(), &first_size) ||
            !GetFileSizeEx(second.get(), &second_size))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to size cleanup broker files for verification");
        }
        if (first_size.QuadPart != second_size.QuadPart)
        {
            return false;
        }
        std::array<unsigned char, 65536> first_buffer{};
        std::array<unsigned char, 65536> second_buffer{};
        while (true)
        {
            DWORD first_read = 0;
            DWORD second_read = 0;
            if (!ReadFile(
                    first.get(),
                    first_buffer.data(),
                    static_cast<DWORD>(first_buffer.size()),
                    &first_read,
                    nullptr) ||
                !ReadFile(
                    second.get(),
                    second_buffer.data(),
                    static_cast<DWORD>(second_buffer.size()),
                    &second_read,
                    nullptr))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to read cleanup broker files for verification");
            }
            if (first_read != second_read ||
                !std::equal(
                    first_buffer.begin(),
                    first_buffer.begin() + first_read,
                    second_buffer.begin()))
            {
                return false;
            }
            if (first_read == 0)
            {
                return true;
            }
        }
    }

    void stage_cleanup_broker_executable()
    {
        validate_cleanup_broker_directory_chain(true);
        const std::filesystem::path source_path = current_executable_path();
        const std::filesystem::path destination_path = legacy_cleanup_broker_executable_path();
        if (normalize_absolute_path(source_path) == normalize_absolute_path(destination_path))
        {
            throw hresult_invalid_argument(
                L"Cleanup broker staging source is already the broker destination");
        }
        const DWORD source_attributes = GetFileAttributesW(source_path.c_str());
        if (source_attributes == INVALID_FILE_ATTRIBUTES ||
            (source_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            throw hresult_invalid_argument(L"Cleanup broker staging source is not a regular file");
        }

        std::filesystem::path temporary_path;
        scoped_handle destination;
        for (unsigned int attempt = 0; attempt < 16; ++attempt)
        {
            temporary_path = destination_path.wstring() +
                L"." + std::to_wstring(GetCurrentProcessId()) +
                L"." + std::to_wstring(GetTickCount64()) +
                L"." + std::to_wstring(attempt) + L".tmp";
            destination.reset(CreateFileW(
                temporary_path.c_str(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                nullptr,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                nullptr));
            if (destination)
            {
                break;
            }
            if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to create a temporary cleanup broker executable");
            }
        }
        if (!destination)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_FILE_EXISTS),
                L"Unable to reserve a temporary cleanup broker executable");
        }

        try
        {
            scoped_handle source(CreateFileW(
                source_path.c_str(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                nullptr,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                nullptr));
            if (!source)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to open the cleanup broker staging source");
            }
            std::array<unsigned char, 65536> buffer{};
            while (true)
            {
                DWORD read = 0;
                if (!ReadFile(
                        source.get(),
                        buffer.data(),
                        static_cast<DWORD>(buffer.size()),
                        &read,
                        nullptr))
                {
                    throw hresult_error(
                        HRESULT_FROM_WIN32(GetLastError()),
                        L"Unable to read the cleanup broker staging source");
                }
                if (read == 0)
                {
                    break;
                }
                write_handle_exact(destination.get(), buffer.data(), read);
            }
            if (!FlushFileBuffers(destination.get()))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to flush the temporary cleanup broker executable");
            }
            source.reset();
            destination.reset();

            DWORD temporary_attributes = GetFileAttributesW(temporary_path.c_str());
            if (temporary_attributes == INVALID_FILE_ATTRIBUTES)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to inspect the temporary cleanup broker executable");
            }
            if ((temporary_attributes & FILE_ATTRIBUTE_ENCRYPTED) != 0)
            {
                if (!DecryptFileW(temporary_path.c_str(), 0))
                {
                    throw hresult_error(
                        HRESULT_FROM_WIN32(GetLastError()),
                        L"Unable to remove inherited encryption from the cleanup broker executable");
                }
                temporary_attributes = GetFileAttributesW(temporary_path.c_str());
            }
            if (temporary_attributes == INVALID_FILE_ATTRIBUTES ||
                (temporary_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
                    FILE_ATTRIBUTE_ENCRYPTED)) != 0 ||
                !files_have_equal_bytes(source_path, temporary_path))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_CRC),
                    L"Temporary cleanup broker executable failed content or attribute verification");
            }
            if (!MoveFileExW(
                    temporary_path.c_str(),
                    destination_path.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to atomically publish the cleanup broker executable");
            }
            temporary_path.clear();
            const DWORD destination_attributes = GetFileAttributesW(destination_path.c_str());
            if (destination_attributes == INVALID_FILE_ATTRIBUTES ||
                (destination_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
                    FILE_ATTRIBUTE_ENCRYPTED)) != 0 ||
                !files_have_equal_bytes(source_path, destination_path))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_CRC),
                    L"Published cleanup broker executable failed content or attribute verification");
            }
        }
        catch (...)
        {
            destination.reset();
            if (!temporary_path.empty())
            {
                DeleteFileW(temporary_path.c_str());
            }
            throw;
        }
    }

    std::wstring cleanup_broker_command_line(
        const std::wstring& optional_package_family_name)
    {
        const std::filesystem::path executable_path = legacy_cleanup_broker_executable_path();
        std::wstring command_line = quote_command_line_argument(executable_path.wstring()) +
            L" legacy-cleanup-broker";
        if (!optional_package_family_name.empty())
        {
            command_line += L" --package-family-name " +
                quote_command_line_argument(optional_package_family_name);
        }
        return command_line;
    }

    void register_cleanup_broker_run_value(
        const std::wstring& optional_package_family_name)
    {
        HKEY raw_key = nullptr;
        DWORD disposition = 0;
        const LSTATUS create_result = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            legacy_cleanup_broker_run_key,
            0,
            nullptr,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            nullptr,
            &raw_key,
            &disposition);
        if (create_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(create_result),
                L"Unable to open the cleanup broker Run registration");
        }
        scoped_registry_key key(raw_key);
        const std::wstring command_line = cleanup_broker_command_line(
            optional_package_family_name);
        const DWORD bytes = static_cast<DWORD>((command_line.size() + 1) * sizeof(wchar_t));
        const LSTATUS set_result = RegSetValueExW(
            key.get(),
            legacy_cleanup_broker_run_value,
            0,
            REG_SZ,
            reinterpret_cast<const BYTE*>(command_line.c_str()),
            bytes);
        if (set_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(set_result),
                L"Unable to register the cleanup broker for user logon");
        }
    }

    void remove_cleanup_broker_run_value()
    {
        HKEY raw_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            legacy_cleanup_broker_run_key,
            0,
            KEY_SET_VALUE,
            &raw_key);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                L"Unable to open the cleanup broker Run registration for deletion");
        }
        scoped_registry_key key(raw_key);
        const LSTATUS delete_result = RegDeleteValueW(
            key.get(),
            legacy_cleanup_broker_run_value);
        if (delete_result != ERROR_SUCCESS && delete_result != ERROR_FILE_NOT_FOUND)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(delete_result),
                L"Unable to remove the cleanup broker Run registration");
        }
    }

    std::optional<std::wstring> read_cleanup_broker_run_value()
    {
        HKEY raw_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            legacy_cleanup_broker_run_key,
            0,
            KEY_QUERY_VALUE,
            &raw_key);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (open_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                L"Unable to inspect the cleanup broker Run registration");
        }
        scoped_registry_key key(raw_key);
        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(
            key.get(),
            legacy_cleanup_broker_run_value,
            nullptr,
            &type,
            nullptr,
            &bytes);
        if (result == ERROR_FILE_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (result != ERROR_SUCCESS || type != REG_SZ ||
            bytes < sizeof(wchar_t) || bytes > 65536)
        {
            throw hresult_error(
                result == ERROR_SUCCESS ? E_INVALIDARG : HRESULT_FROM_WIN32(result),
                L"Cleanup broker Run registration is invalid");
        }
        std::vector<wchar_t> value((bytes / sizeof(wchar_t)) + 1, L'\0');
        result = RegQueryValueExW(
            key.get(),
            legacy_cleanup_broker_run_value,
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the cleanup broker Run registration");
        }
        return std::wstring(value.data());
    }

    bool any_allowed_memmy_package_is_registered()
    {
        return !registered_package_full_names(allowed_memmy_package_family).empty() ||
            !registered_package_full_names(allowed_memmy_agent_package_family).empty();
    }

    void validate_offline_cleanup_broker_stop()
    {
        const auto journal = read_cleanup_journal();
        if (journal)
        {
            validate_legacy_transition_options(journal->options, true, false);
            if (!journal->options.external_helper_path.empty())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Cleanup journal contains a deprecated external helper path");
            }
            require_allowed_memmy_package_identity(journal->options);
            validate_persisted_authority_shape(journal->authority, journal->options);
            if (any_allowed_memmy_package_is_registered())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Refusing offline cleanup broker shutdown while a Memmy Store package is registered");
            }
            const auto journal_run_value = read_cleanup_broker_run_value();
            if (journal_run_value &&
                *journal_run_value != cleanup_broker_command_line(L"") &&
                *journal_run_value != cleanup_broker_command_line(
                    journal->options.package_family_name))
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Refusing to modify a cleanup broker Run registration that does not match its journal");
            }
            if (journal->phase == LegacyCleanupJournalPhase::Acknowledged)
            {
                remove_cleanup_broker_run_value();
                delete_cleanup_journal_file(
                    L"Unable to retire the acknowledged cleanup journal during offline shutdown");
                return;
            }
        }
        const auto run_value = read_cleanup_broker_run_value();
        if (!run_value)
        {
            return;
        }
        if (any_allowed_memmy_package_is_registered())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Refusing offline cleanup broker shutdown while a Memmy Store package is registered");
        }
        if (*run_value == cleanup_broker_command_line(L""))
        {
            return;
        }
        const wchar_t* allowed_package_families[] = {
            allowed_memmy_package_family,
            allowed_memmy_agent_package_family
        };
        for (const wchar_t* package_family : allowed_package_families)
        {
            if (*run_value == cleanup_broker_command_line(package_family))
            {
                return;
            }
        }
        throw hresult_error(
            E_ACCESSDENIED,
            L"Refusing to modify an unrecognized cleanup broker Run registration");
    }

    DWORD launch_cleanup_broker_process(
        const std::wstring& optional_package_family_name)
    {
        const std::filesystem::path executable_path = legacy_cleanup_broker_executable_path();
        std::wstring command_line = cleanup_broker_command_line(
            optional_package_family_name);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(
                executable_path.c_str(),
                command_line.data(),
                nullptr,
                nullptr,
                FALSE,
                CREATE_NO_WINDOW | DETACHED_PROCESS,
                nullptr,
                executable_path.parent_path().c_str(),
                &startup,
                &process))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to start the native legacy cleanup broker");
        }
        const DWORD process_id = process.dwProcessId;
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return process_id;
    }

    void throw_broker_response_failure(const LegacyCleanupBrokerResponse& response)
    {
        if (SUCCEEDED(response.hresult))
        {
            return;
        }
        if (legacy_cleanup_diagnostics)
        {
            legacy_cleanup_diagnostics->failure_process_role = "native-cleanup-broker";
            set_legacy_cleanup_failure_context(
                response.operation,
                response.target,
                response.win32_error);
        }
        throw hresult_error(
            response.hresult,
            to_hstring(
                "Native legacy cleanup broker failed; operation=" + response.operation +
                "; target=" + response.target +
                (response.win32_error
                    ? "; win32Error=" + std::to_string(*response.win32_error)
                    : "") +
                "; message=" + response.message));
    }

    bool try_stop_cleanup_broker(DWORD wait_milliseconds)
    {
        scoped_handle pipe(CreateFileW(
            legacy_cleanup_broker_pipe_name().c_str(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr));
        if (!pipe)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_FILE_NOT_FOUND)
            {
                return false;
            }
            if (error == ERROR_PIPE_BUSY && wait_milliseconds != 0)
            {
                pipe = connect_to_cleanup_broker(wait_milliseconds);
            }
            else
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to connect to the cleanup broker for shutdown");
            }
        }
        validate_cleanup_broker_server(pipe.get());
        const DWORD server_process_id = named_pipe_server_process_id(pipe.get());
        scoped_handle server_process(OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            server_process_id));
        send_broker_frame(pipe.get(), LegacyCleanupBrokerMessage::Stop, {});
        auto [message, payload] = receive_broker_frame(pipe.get());
        if (message != LegacyCleanupBrokerMessage::Response)
        {
            throw hresult_invalid_argument(L"Cleanup broker shutdown returned a non-response frame");
        }
        throw_broker_response_failure(deserialize_broker_response(payload));
        pipe.reset();
        if (server_process &&
            WaitForSingleObject(server_process.get(), wait_milliseconds) == WAIT_TIMEOUT)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Cleanup broker did not exit after shutdown");
        }
        return true;
    }

    void ensure_legacy_cleanup_broker(const std::wstring& optional_package_family_name)
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker installation must run from an unpackaged process");
        }
        if (!optional_package_family_name.empty())
        {
            LegacyTransitionOptions identity_options;
            identity_options.package_family_name = optional_package_family_name;
            identity_options.aumid = optional_package_family_name + L"!Memmy";
            require_allowed_memmy_package_identity(identity_options);
        }
        retire_orphaned_cleanup_journal_for_native_install();
        validate_offline_cleanup_broker_stop();
        try_stop_cleanup_broker(10000);
        stage_cleanup_broker_executable();
        register_cleanup_broker_run_value(optional_package_family_name);
        try
        {
            launch_cleanup_broker_process(optional_package_family_name);
            const LegacyCleanupBrokerResponse response = request_cleanup_broker(
                LegacyCleanupBrokerMessage::Ping,
                nullptr,
                10000);
            throw_broker_response_failure(response);
        }
        catch (...)
        {
            try
            {
                remove_cleanup_broker_run_value();
            }
            catch (...)
            {
            }
            throw;
        }
    }

    void stop_legacy_cleanup_broker()
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup broker shutdown must run from an unpackaged process");
        }
        const bool stopped = try_stop_cleanup_broker(10000);
        if (!stopped)
        {
            validate_offline_cleanup_broker_stop();
        }
        remove_cleanup_broker_run_value();
    }

    void validate_cleanup_request_against_capture(
        const LegacyTransitionOptions& options,
        const LegacyAuthorityCapture& capture)
    {
        const std::filesystem::path expected_desktop_shortcut =
            resolve_known_folder_path(
                FOLDERID_Desktop,
                L"The current user's Desktop directory is unavailable for broker validation") /
            L"Memmy.lnk";
        if (normalize_absolute_path(options.legacy_install_directory) !=
                normalize_absolute_path(capture.install_directory) ||
            normalize_absolute_path(options.legacy_executable_path.parent_path()) !=
                normalize_absolute_path(capture.install_directory) ||
            _wcsicmp(options.legacy_executable_path.filename().c_str(), L"Memmy.exe") != 0 ||
            options.shortcut_path.empty() ||
            normalize_absolute_path(options.shortcut_path) !=
                normalize_absolute_path(expected_desktop_shortcut))
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup request does not match the broker's captured source and fixed shortcut policy");
        }
    }

    LegacyTransitionOptions derive_trusted_cleanup_options(
        const LegacyTransitionOptions& request,
        const LegacyAuthorityCapture& capture)
    {
        LegacyTransitionOptions trusted = request;
        trusted.external_helper_path.clear();
        trusted.legacy_install_directory = capture.install_directory;
        trusted.legacy_executable_path = capture.install_directory / L"Memmy.exe";
        trusted.shortcut_path = resolve_known_folder_path(
            FOLDERID_Desktop,
            L"The current user's Desktop directory is unavailable for broker cleanup") /
            L"Memmy.lnk";
        return trusted;
    }

    scoped_handle acquire_cleanup_active_marker()
    {
        const std::wstring source_lease_pipe = legacy_transition_source_lease_pipe_name();
        if (!exclusive_pipe_name_is_owned(source_lease_pipe))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_RETRY),
                L"Store transition source lease is not held before cleanup");
        }
        scoped_handle marker(create_user_restricted_pipe(
            legacy_transition_cleanup_active_pipe_name(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            1));
        if (!marker)
        {
            const DWORD error = GetLastError();
            throw hresult_error(
                HRESULT_FROM_WIN32(
                    error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY
                        ? ERROR_BUSY
                        : error),
                L"Unable to acquire the Store transition cleanup-active marker");
        }
        if (!exclusive_pipe_name_is_owned(source_lease_pipe))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_RETRY),
                L"Store transition source lease was released before cleanup began");
        }
        return marker;
    }

    void require_post_mutex_cleanup_authorization(
        const LegacyTransitionOptions& options)
    {
        if (!exclusive_pipe_name_is_owned(legacy_transition_source_lease_pipe_name()))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_RETRY),
                L"Store transition source lease was released while cleanup waited for the mutation mutex");
        }
        if (registered_package_full_names(options.package_family_name).empty())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_RETRY),
                L"The requesting Store package is no longer registered after cleanup acquired the mutation mutex");
        }
    }

    scoped_handle create_transition_mutation_mutex()
    {
        scoped_handle mutex(CreateMutexW(
            nullptr,
            FALSE,
            legacy_transition_mutation_mutex_name));
        if (!mutex)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to create the NSIS and Store transition mutation mutex");
        }
        return mutex;
    }

    bool recover_orphaned_cleanup_journal()
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Orphan cleanup journal recovery requires an unpackaged process");
        }
        // Acquire in the same order as destructive cleanup. Never borrow a
        // running NSIS source lease or temporarily drop its cleanup guard.
        scoped_handle cleanup_guard(create_user_restricted_pipe(
            legacy_transition_cleanup_active_pipe_name(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            1));
        if (!cleanup_guard)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to acquire the orphan journal recovery cleanup guard");
        }
        scoped_handle mutation_mutex = create_transition_mutation_mutex();
        scoped_mutex_ownership mutation_ownership;
        mutation_ownership.acquire(mutation_mutex.get());

        // The TypeScript existence check is only an optimization. Re-read and
        // attest the fixed journal and both allowed package registrations here,
        // while both locks exclude another cleanup or NSIS mutation.
        const auto journal = read_cleanup_journal();
        if (!journal)
        {
            return false;
        }
        validate_orphaned_cleanup_journal_for_native_install(*journal);
        delete_cleanup_journal_file(L"Unable to recover the orphaned cleanup journal");
        return true;
    }

    void require_parent_held_transition_mutation_mutex()
    {
        scoped_handle mutex(OpenMutexW(
            SYNCHRONIZE | MUTEX_MODIFY_STATE,
            FALSE,
            legacy_transition_mutation_mutex_name));
        if (!mutex)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"NSIS mutation authorization requires the transition mutex");
        }
        const DWORD wait_result = WaitForSingleObject(mutex.get(), 0);
        if (wait_result == WAIT_TIMEOUT)
        {
            return;
        }
        if (wait_result == WAIT_OBJECT_0 || wait_result == WAIT_ABANDONED)
        {
            ReleaseMutex(mutex.get());
            throw hresult_error(
                E_ACCESSDENIED,
                L"NSIS mutation authorization requires its parent to hold the transition mutex");
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(GetLastError()),
            L"Unable to verify NSIS transition mutex ownership");
    }

    void authorize_nsis_mutation()
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"NSIS mutation authorization must run from an unpackaged process");
        }
        const std::wstring user_sid = current_user_sid();
        const DWORD session_id = current_process_session_id();
        validate_cleanup_broker_parent_process(user_sid, session_id);
        require_parent_held_transition_mutation_mutex();
        if (exclusive_pipe_name_is_owned(legacy_transition_cleanup_active_pipe_name()))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_BUSY),
                L"NSIS mutation is blocked while Store cleanup is active");
        }
        if (any_allowed_memmy_package_is_registered())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"NSIS mutation is blocked while a Memmy Store package is registered");
        }
        const auto journal = read_cleanup_journal();
        if (!journal)
        {
            return;
        }
        validate_legacy_transition_options(journal->options, true, false);
        if (!journal->options.external_helper_path.empty())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Cleanup journal contains a deprecated external helper path");
        }
        require_allowed_memmy_package_identity(journal->options);
        validate_persisted_authority_shape(journal->authority, journal->options);
    }

    LegacyCleanupBrokerResponse cleanup_broker_error_response(
        HRESULT hresult,
        const std::string& message,
        const std::wstring& transition_id,
        const std::wstring& attempt_id)
    {
        LegacyCleanupBrokerResponse response;
        response.hresult = hresult;
        response.transition_id = transition_id;
        response.attempt_id = attempt_id;
        response.message = single_line(message);
        if (legacy_cleanup_diagnostics)
        {
            response.operation = legacy_cleanup_diagnostics->current_operation;
            response.target = legacy_cleanup_diagnostics->current_target;
            response.win32_error = legacy_cleanup_diagnostics->current_win32_error
                ? legacy_cleanup_diagnostics->current_win32_error
                : win32_error_from_hresult(hresult);
            write_legacy_cleanup_process_failure(hresult, message);
        }
        else
        {
            response.operation = "cleanup-broker-request";
            response.win32_error = win32_error_from_hresult(hresult);
        }
        return response;
    }

    int run_legacy_cleanup_broker(const std::wstring& optional_package_family_name)
    {
        if (!optional_package_family_name.empty())
        {
            LegacyTransitionOptions identity_options;
            identity_options.package_family_name = optional_package_family_name;
            identity_options.aumid = optional_package_family_name + L"!Memmy";
            require_allowed_memmy_package_identity(identity_options);
        }
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Native cleanup broker must start without package identity");
        }
        validate_cleanup_broker_executable();
        initialize_cleanup_broker_startup_diagnostics();
        const std::wstring user_sid = current_user_sid();
        const DWORD session_id = current_process_session_id();
        validate_cleanup_broker_parent_process(user_sid, session_id);
        std::optional<LegacyCleanupJournal> active_journal = read_cleanup_journal();
        LegacyAuthorityCapture authority_capture;
        std::wstring broker_bound_package_family_name = optional_package_family_name;
        if (active_journal)
        {
            validate_legacy_transition_options(active_journal->options, true, false);
            if (!active_journal->options.external_helper_path.empty())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Cleanup journal contains a deprecated external helper path");
            }
            require_allowed_memmy_package_identity(active_journal->options);
            validate_persisted_authority_shape(
                active_journal->authority,
                active_journal->options);
            if (!broker_bound_package_family_name.empty() &&
                broker_bound_package_family_name != active_journal->options.package_family_name)
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Cleanup journal package family does not match the broker binding");
            }
            broker_bound_package_family_name = active_journal->options.package_family_name;
            if (active_journal->phase == LegacyCleanupJournalPhase::Acknowledged)
            {
                append_legacy_cleanup_diagnostic(
                    "cleanup-journal-recovery",
                    "acknowledged",
                    "retire-acknowledged-run-registration",
                    utf8(legacy_cleanup_journal_path().wstring()),
                    std::nullopt,
                    S_OK,
                    "transitionId=" + utf8(active_journal->options.transition_id));
                remove_cleanup_broker_run_value();
                return 0;
            }
            authority_capture = active_journal->authority;
            authority_capture.session_id = session_id;
            if (active_journal->phase == LegacyCleanupJournalPhase::Complete)
            {
                verify_complete_cleanup_postconditions(
                    authority_capture,
                    active_journal->options);
            }
            else
            {
                verify_recoverable_authority_state(
                    authority_capture,
                    active_journal->options);
            }
            append_legacy_cleanup_diagnostic(
                "cleanup-journal-recovery",
                active_journal->phase == LegacyCleanupJournalPhase::Complete
                    ? "complete"
                    : "prepared",
                active_journal->phase == LegacyCleanupJournalPhase::Complete
                    ? "validate-complete-journal"
                    : "validate-prepared-journal",
                utf8(legacy_cleanup_journal_path().wstring()),
                std::nullopt,
                S_OK,
                "transitionId=" + utf8(active_journal->options.transition_id) +
                    "; attemptId=" + utf8(active_journal->options.attempt_id));
        }
        else
        {
            authority_capture = capture_legacy_cleanup_authority();
        }
        if (_wcsicmp(authority_capture.user_sid.c_str(), user_sid.c_str()) != 0 ||
            authority_capture.session_id != session_id)
        {
            throw hresult_error(E_ACCESSDENIED, L"Cleanup broker authority capture changed process context");
        }

        bool exit_after_response = false;
        while (!exit_after_response)
        {
            scoped_handle pipe(create_user_restricted_pipe(
                legacy_cleanup_broker_pipe_name(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                1));
            if (!pipe)
            {
                const DWORD error = GetLastError();
                throw hresult_error(
                    HRESULT_FROM_WIN32(
                        error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY
                            ? ERROR_ALREADY_EXISTS
                            : error),
                    L"Another cleanup broker already owns the current session pipe");
            }
            const BOOL connected = ConnectNamedPipe(pipe.get(), nullptr);
            const DWORD connect_error = connected ? ERROR_SUCCESS : GetLastError();
            if (!connected && connect_error != ERROR_PIPE_CONNECTED)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(connect_error),
                    L"Unable to accept a cleanup broker client");
            }

            LegacyCleanupBrokerResponse response;
            scoped_handle cleanup_active_marker;
            scoped_handle transition_mutation_mutex;
            scoped_mutex_ownership transition_mutation_ownership;
            try
            {
                const DWORD client_process_id = named_pipe_client_process_id(pipe.get());
                scoped_handle client = open_verified_pipe_peer_process(
                    client_process_id,
                    authority_capture.user_sid,
                    authority_capture.session_id);
                auto [message, payload] = receive_broker_frame(pipe.get());
                if (message == LegacyCleanupBrokerMessage::Ping)
                {
                    if (!payload.empty())
                    {
                        throw hresult_invalid_argument(L"Cleanup broker ping contains a payload");
                    }
                    response.message = "ready";
                }
                else if (message == LegacyCleanupBrokerMessage::Stop)
                {
                    if (!payload.empty())
                    {
                        throw hresult_invalid_argument(L"Cleanup broker stop contains a payload");
                    }
                    if (process_package_family(client.get()))
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Cleanup broker shutdown requires an unpackaged client");
                    }
                    if (any_allowed_memmy_package_is_registered())
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Refusing to stop a cleanup broker while a Memmy Store package is registered");
                    }
                    if (active_journal)
                    {
                        if (active_journal->phase == LegacyCleanupJournalPhase::Acknowledged)
                        {
                            remove_cleanup_broker_run_value();
                            delete_cleanup_journal_file(
                                L"Unable to retire the acknowledged cleanup journal during broker shutdown");
                            active_journal.reset();
                        }
                    }
                    remove_cleanup_broker_run_value();
                    response.message = "stopped";
                    exit_after_response = true;
                }
                else if (message == LegacyCleanupBrokerMessage::Acknowledge)
                {
                    LegacyTransitionOptions options = deserialize_legacy_transition_options(payload);
                    response.transition_id = options.transition_id;
                    response.attempt_id = options.attempt_id;
                    initialize_legacy_cleanup_diagnostics(options, "native-cleanup-broker-ack");
                    begin_legacy_cleanup_operation("ack-options-validate");
                    validate_legacy_transition_options(options, true, false);
                    if (!options.external_helper_path.empty())
                    {
                        throw hresult_invalid_argument(
                            L"Cleanup broker acknowledgement must not contain an external helper path");
                    }
                    require_allowed_memmy_package_identity(options);
                    if (!active_journal ||
                        (active_journal->phase != LegacyCleanupJournalPhase::Complete &&
                         active_journal->phase != LegacyCleanupJournalPhase::Acknowledged) ||
                        !equivalent_transition_options(active_journal->options, options) ||
                        (!broker_bound_package_family_name.empty() &&
                         options.package_family_name != broker_bound_package_family_name))
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Cleanup acknowledgement does not match a completed broker transaction");
                    }
                    complete_legacy_cleanup_operation();

                    begin_legacy_cleanup_operation(
                        "ack-client-identity-attestation",
                        std::to_string(client_process_id));
                    validate_cleanup_broker_client(pipe.get(), options, authority_capture);
                    complete_legacy_cleanup_operation(
                        "packageFamilyName=" + utf8(options.package_family_name) +
                        "; aumid=" + utf8(options.aumid));

                    if (active_journal->phase == LegacyCleanupJournalPhase::Complete)
                    {
                        begin_legacy_cleanup_operation(
                            "ack-native-postconditions",
                            utf8(authority_capture.install_directory.wstring()));
                        verify_complete_cleanup_postconditions(authority_capture, options);
                        complete_legacy_cleanup_operation("nativeCleanupStillComplete=true");

                        begin_legacy_cleanup_operation(
                            "ack-journal-commit",
                            utf8(legacy_cleanup_journal_path().wstring()));
                        LegacyCleanupJournal acknowledged_journal = *active_journal;
                        acknowledged_journal.phase = LegacyCleanupJournalPhase::Acknowledged;
                        write_cleanup_journal_atomic(acknowledged_journal);
                        *active_journal = std::move(acknowledged_journal);
                        complete_legacy_cleanup_operation("phase=acknowledged");
                    }
                    else
                    {
                        begin_legacy_cleanup_operation(
                            "ack-journal-replay",
                            utf8(legacy_cleanup_journal_path().wstring()));
                        complete_legacy_cleanup_operation(
                            "durableAcknowledgementReplayed=true");
                    }

                    remove_cleanup_broker_run_value();
                    response.message = "cleanup-acknowledged-durable";
                    exit_after_response = true;
                }
                else if (message == LegacyCleanupBrokerMessage::Cleanup)
                {
                    LegacyTransitionOptions options = deserialize_legacy_transition_options(payload);
                    response.transition_id = options.transition_id;
                    response.attempt_id = options.attempt_id;
                    initialize_legacy_cleanup_diagnostics(options, "native-cleanup-broker");
                    begin_legacy_cleanup_operation("options-validate");
                    validate_legacy_transition_options(options, true, false);
                    if (!options.external_helper_path.empty())
                    {
                        throw hresult_invalid_argument(
                            L"Cleanup broker request must not contain an external helper path");
                    }
                    require_allowed_memmy_package_identity(options);
                    if (!broker_bound_package_family_name.empty() &&
                        options.package_family_name != broker_bound_package_family_name)
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Cleanup request package family does not match the broker binding");
                    }
                    if (active_journal &&
                        !equivalent_transition_options(active_journal->options, options))
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Cleanup request does not match the broker's prepared journal");
                    }
                    complete_legacy_cleanup_operation();

                    begin_legacy_cleanup_operation(
                        "client-identity-attestation",
                        std::to_string(client_process_id));
                    validate_cleanup_broker_client(pipe.get(), options, authority_capture);
                    complete_legacy_cleanup_operation(
                        "packageFamilyName=" + utf8(options.package_family_name) +
                        "; aumid=" + utf8(options.aumid));

                    begin_legacy_cleanup_operation(
                        "broker-authority-attestation",
                        utf8(authority_capture.install_directory.wstring()));
                    if (current_process_has_package_identity() ||
                        _wcsicmp(current_user_sid().c_str(), authority_capture.user_sid.c_str()) != 0 ||
                        current_process_session_id() != authority_capture.session_id)
                    {
                        throw hresult_error(
                            E_ACCESSDENIED,
                            L"Cleanup broker process context changed after startup attestation");
                    }
                    validate_cleanup_request_against_capture(options, authority_capture);
                    const LegacyTransitionOptions trusted_options =
                        derive_trusted_cleanup_options(options, authority_capture);
                    if (active_journal &&
                        active_journal->phase == LegacyCleanupJournalPhase::Acknowledged)
                    {
                        complete_legacy_cleanup_operation(
                            "brokerContextAndAcknowledgedJournalSourceMatch=true");
                        begin_legacy_cleanup_operation(
                            "acknowledged-cleanup-native-postconditions",
                            utf8(authority_capture.install_directory.wstring()));
                        verify_complete_cleanup_postconditions(
                            authority_capture,
                            trusted_options);
                        complete_legacy_cleanup_operation(
                            "acknowledgedJournalAndNativePostconditionsMatch=true");
                        response.message = "cleanup-already-acknowledged";
                    }
                    else if (active_journal &&
                        active_journal->phase == LegacyCleanupJournalPhase::Complete)
                    {
                        complete_legacy_cleanup_operation(
                            "brokerContextAndCompleteJournalSourceMatch=true");
                        begin_legacy_cleanup_operation(
                            "cleanup-active-marker-acquire",
                            utf8(legacy_transition_cleanup_active_pipe_name()));
                        cleanup_active_marker = acquire_cleanup_active_marker();
                        complete_legacy_cleanup_operation(
                            "sourceLeaseHeld=true; cleanupActiveHeld=true; replay=true");
                        begin_legacy_cleanup_operation(
                            "transition-mutation-mutex-acquire",
                            "Local\\MemmyStoreTransitionNsisMutation");
                        transition_mutation_mutex = create_transition_mutation_mutex();
                        transition_mutation_ownership.acquire(transition_mutation_mutex.get());
                        complete_legacy_cleanup_operation("owned=true; replay=true");
                        begin_legacy_cleanup_operation(
                            "post-mutex-cleanup-authorization",
                            utf8(options.package_family_name));
                        require_post_mutex_cleanup_authorization(trusted_options);
                        complete_legacy_cleanup_operation(
                            "sourceLeaseHeld=true; packageRegistered=true; replay=true");
                        begin_legacy_cleanup_operation(
                            "complete-cleanup-native-postconditions",
                            utf8(authority_capture.install_directory.wstring()));
                        verify_complete_cleanup_postconditions(
                            authority_capture,
                            trusted_options);
                        complete_legacy_cleanup_operation(
                            "completeJournalAndNativePostconditionsMatch=true");
                        response.message = "cleanup-complete-replayed-by-native-broker";
                    }
                    else
                    {
                        begin_legacy_cleanup_operation(
                            "cleanup-active-marker-acquire",
                            utf8(legacy_transition_cleanup_active_pipe_name()));
                        cleanup_active_marker = acquire_cleanup_active_marker();
                        complete_legacy_cleanup_operation("sourceLeaseHeld=true; cleanupActiveHeld=true");

                        begin_legacy_cleanup_operation(
                            "transition-mutation-mutex-acquire",
                            "Local\\MemmyStoreTransitionNsisMutation");
                        transition_mutation_mutex = create_transition_mutation_mutex();
                        transition_mutation_ownership.acquire(transition_mutation_mutex.get());
                        complete_legacy_cleanup_operation("owned=true");

                        begin_legacy_cleanup_operation(
                            "post-mutex-cleanup-authorization",
                            utf8(options.package_family_name));
                        require_post_mutex_cleanup_authorization(trusted_options);
                        complete_legacy_cleanup_operation(
                            "sourceLeaseHeld=true; packageRegistered=true");

                        begin_legacy_cleanup_operation(
                            "broker-authority-mutation-attestation",
                            utf8(authority_capture.install_directory.wstring()));
                        if (active_journal)
                        {
                            verify_recoverable_authority_state(
                                authority_capture,
                                trusted_options);
                            complete_legacy_cleanup_operation(
                                "preparedJournalAndRecoverableAuthorityMatch=true");
                        }
                        else
                        {
                            verify_legacy_cleanup_authority_unchanged(authority_capture);
                            complete_legacy_cleanup_operation(
                                "startupCaptureAndCurrentAuthorityMatch=true");
                        }

                        if (!active_journal)
                        {
                            LegacyCleanupJournal prepared_journal{
                                LegacyCleanupJournalPhase::Prepared,
                                trusted_options,
                                authority_capture
                            };
                            begin_legacy_cleanup_operation(
                                "cleanup-journal-prepare",
                                utf8(legacy_cleanup_journal_path().wstring()));
                            write_cleanup_journal_atomic(prepared_journal);
                            active_journal = std::move(prepared_journal);
                            complete_legacy_cleanup_operation("phase=prepared");
                        }

                        finalize_legacy_cleanup_unpacked(trusted_options, true);
                        // The inner cleanup routine checks the caller's HKCU view. Before
                        // attesting completion, independently re-open the captured native
                        // HKCU/HKU<SID> authority in both registry views and verify the
                        // install directory is gone. If this fails, leave the durable journal
                        // in Prepared so a later broker request can safely retry cleanup.
                        begin_legacy_cleanup_operation(
                            "broker-native-cleanup-postcheck",
                            utf8(authority_capture.install_directory.wstring()));
                        verify_complete_cleanup_postconditions(
                            authority_capture,
                            trusted_options);
                        complete_legacy_cleanup_operation(
                            "nativeHkcuAndHkuPostconditionsMatch=true");
                        begin_legacy_cleanup_operation(
                            "cleanup-journal-complete",
                            utf8(legacy_cleanup_journal_path().wstring()));
                        LegacyCleanupJournal completed_journal = *active_journal;
                        completed_journal.phase = LegacyCleanupJournalPhase::Complete;
                        write_cleanup_journal_atomic(completed_journal);
                        *active_journal = std::move(completed_journal);
                        complete_legacy_cleanup_operation("phase=complete");
                        response.message = "cleanup-complete-awaiting-store-ack";
                    }
                }
                else
                {
                    throw hresult_invalid_argument(L"Cleanup broker received an invalid request type");
                }
            }
            catch (const hresult_error& error)
            {
                response = cleanup_broker_error_response(
                    error.code(),
                    to_string(error.message()),
                    response.transition_id,
                    response.attempt_id);
                exit_after_response = false;
            }
            catch (const std::filesystem::filesystem_error& error)
            {
                const DWORD win32_error = static_cast<DWORD>(error.code().value());
                const HRESULT hresult = HRESULT_FROM_WIN32(win32_error);
                const std::string target = !error.path1().empty()
                    ? utf8(error.path1().wstring())
                    : (!error.path2().empty() ? utf8(error.path2().wstring()) : "");
                set_legacy_cleanup_failure_context("std::filesystem", target, win32_error);
                response = cleanup_broker_error_response(
                    hresult,
                    error.what(),
                    response.transition_id,
                    response.attempt_id);
                exit_after_response = false;
            }
            catch (const std::exception& error)
            {
                response = cleanup_broker_error_response(
                    E_FAIL,
                    error.what(),
                    response.transition_id,
                    response.attempt_id);
                exit_after_response = false;
            }

            try
            {
                send_broker_frame(
                    pipe.get(),
                    LegacyCleanupBrokerMessage::Response,
                    serialize_broker_response(response));
                FlushFileBuffers(pipe.get());
            }
            catch (const hresult_error& error)
            {
                // The journal is the durable result. In particular, a Cleanup
                // response can be lost after Complete was committed. Keep the
                // broker alive for another client request instead of requiring
                // a new logon merely to replay that journal. ACK/Stop already
                // set exit_after_response and retain their durable/offline
                // recovery paths.
                append_legacy_cleanup_diagnostic(
                    "broker-response-write",
                    "failed",
                    "named-pipe-response",
                    utf8(legacy_cleanup_broker_pipe_name()),
                    std::nullopt,
                    error.code(),
                    std::string("durableStatePreserved=true; continueListening=") +
                        (exit_after_response ? "false" : "true"));
            }
            catch (...)
            {
                append_legacy_cleanup_diagnostic(
                    "broker-response-write",
                    "failed",
                    "named-pipe-response",
                    utf8(legacy_cleanup_broker_pipe_name()),
                    std::nullopt,
                    E_FAIL,
                    std::string("durableStatePreserved=true; continueListening=") +
                        (exit_after_response ? "false" : "true"));
            }
            DisconnectNamedPipe(pipe.get());
            transition_mutation_ownership.reset();
            transition_mutation_mutex.reset();
            cleanup_active_marker.reset();
        }
        return 0;
    }

    bool matching_acknowledged_cleanup_proof_exists(
        const LegacyTransitionOptions& options);

    void finalize_legacy_cleanup_via_broker(const LegacyTransitionOptions& options)
    {
        begin_legacy_cleanup_operation(
            "cleanup-broker-connect",
            utf8(legacy_cleanup_broker_pipe_name()));
        LegacyCleanupBrokerResponse response;
        try
        {
            response = request_cleanup_broker(
                LegacyCleanupBrokerMessage::Cleanup,
                &options,
                10000);
        }
        catch (...)
        {
            const std::exception_ptr broker_failure = std::current_exception();
            begin_legacy_cleanup_operation(
                "cleanup-broker-finalize-proof-replay",
                utf8(legacy_cleanup_journal_path().wstring()));
            if (matching_acknowledged_cleanup_proof_exists(options))
            {
                complete_legacy_cleanup_operation(
                    "durableAcknowledgementMatched=true; finalizeReplay=true");
                return;
            }
            std::rethrow_exception(broker_failure);
        }
        if (FAILED(response.hresult))
        {
            throw_broker_response_failure(response);
        }
        complete_legacy_cleanup_operation("brokerAttestedCleanup=true");
    }

    bool matching_acknowledged_cleanup_proof_exists(
        const LegacyTransitionOptions& options)
    {
        // This fallback performs no cleanup mutation. Acknowledged is written only
        // by the unpackaged broker after native post-checks and an authenticated
        // packaged acknowledgement; unlike Complete, it is safe to replay when
        // the acknowledgement response or broker exit raced the packaged client.
        const auto journal = read_cleanup_journal();
        if (!journal || journal->phase != LegacyCleanupJournalPhase::Acknowledged)
        {
            return false;
        }
        validate_legacy_transition_options(journal->options, true, false);
        if (!journal->options.external_helper_path.empty())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Acknowledged cleanup proof contains a deprecated external helper path");
        }
        require_allowed_memmy_package_identity(journal->options);
        validate_persisted_authority_shape(journal->authority, journal->options);
        return equivalent_transition_options(journal->options, options);
    }

    void acknowledge_legacy_cleanup_via_broker(const LegacyTransitionOptions& options)
    {
        begin_legacy_cleanup_operation(
            "cleanup-broker-ack-connect",
            utf8(legacy_cleanup_broker_pipe_name()));
        LegacyCleanupBrokerResponse response;
        try
        {
            response = request_cleanup_broker(
                LegacyCleanupBrokerMessage::Acknowledge,
                &options,
                10000);
        }
        catch (...)
        {
            const std::exception_ptr broker_failure = std::current_exception();
            begin_legacy_cleanup_operation(
                "cleanup-broker-ack-proof-replay",
                utf8(legacy_cleanup_journal_path().wstring()));
            if (matching_acknowledged_cleanup_proof_exists(options))
            {
                complete_legacy_cleanup_operation(
                    "durableAcknowledgementMatched=true");
                return;
            }
            std::rethrow_exception(broker_failure);
        }
        if (FAILED(response.hresult))
        {
            throw_broker_response_failure(response);
        }
        complete_legacy_cleanup_operation("brokerAcknowledged=true");
    }

    void launch_store_update_finalizer_breakaway(
        const StoreInstallHandoffOptions& options)
    {
        const auto executable_path = current_executable_path();
        launch_detached_process(
            executable_path,
            build_store_finalizer_arguments(
                executable_path,
                L"launch-store-update-finalizer",
                options,
                true),
            true);
        append_handoff_log(options.log_path, "finalizer-breakaway-started");
    }

    void launch_external_store_update_finalizer(
        const StoreInstallHandoffOptions& options)
    {
        launch_detached_process(
            options.external_helper_path,
            build_store_finalizer_arguments(
                options.external_helper_path,
                L"finalize-store-update",
                options,
                false),
            false);
        append_handoff_log(options.log_path, "external-finalizer-started");
    }

    void wait_for_old_application_exit(const StoreInstallHandoffOptions& options)
    {
        const HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, options.old_process_id);
        if (process == nullptr)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_INVALID_PARAMETER)
            {
                return;
            }
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to wait for the existing Memmy process");
        }
        const DWORD wait_result = WaitForSingleObject(process, 120000);
        const DWORD wait_error = wait_result == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
        CloseHandle(process);
        if (wait_result == WAIT_TIMEOUT)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Existing Memmy process did not finish its normal quit flow");
        }
        if (wait_result != WAIT_OBJECT_0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(wait_error),
                L"Unable to observe the existing Memmy process exit");
        }
        append_handoff_log(options.log_path, "old-process-exited");
    }

    void report_store_install_shutdown_unavailable(
        const StoreInstallHandoffOptions& options,
        const std::string& reason)
    {
        // Publishing the failure lets the external finalizer activate the app.
        // First wait for the quitting instance, otherwise activation can be
        // delivered to that instance just before it exits. If this bounded wait
        // fails, leave recovery to the finalizer's existing overall timeout.
        wait_for_old_application_exit(options);
        write_store_install_result(options, "installer-shutdown-unavailable", "", reason);
    }

    int finalize_store_update(const StoreInstallHandoffOptions& options)
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Store update finalizer must run outside the application package");
        }
        append_handoff_log(
            options.log_path,
            "finalizer-monitoring",
            utf8(options.mode),
            "",
            "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                "; baselinePackageFullName=" + utf8(options.baseline_package_full_name) +
                "; oldPid=" + std::to_string(options.old_process_id));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(15);
        std::string failure_state;
        std::string failure_hresult;
        std::string failure_reason;
        while (std::chrono::steady_clock::now() < deadline)
        {
            try
            {
                if (installed_package_replaced_baseline(options))
                {
                    DeleteFileW(options.state_path.c_str());
                    DeleteFileW(options.result_path.c_str());
                    append_handoff_log(options.log_path, "replacement-package-ready", "completed");
                    if (options.mode == L"manual")
                    {
                        return activate_store_application_with_retry(options, "completed") ? 0 : 3;
                    }
                    return 0;
                }
            }
            catch (const hresult_error& error)
            {
                append_handoff_log(
                    options.log_path,
                    "package-version-query-retry",
                    "",
                    hresult_text(error.code()),
                    to_string(error.message()));
            }

            const StoreInstallResultFile result = read_store_install_result(options.result_path);
            if (result.available && result.state != "completed")
            {
                failure_state = result.state.empty() ? "installer-error" : result.state;
                failure_hresult = result.hresult;
                failure_reason = result.reason.empty()
                    ? "The Microsoft Store did not complete the update"
                    : result.reason;
                break;
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        if (failure_state.empty())
        {
            failure_state = "timeout";
            failure_reason = "The Microsoft Store update did not replace the baseline package before timeout";
        }
        write_failed_store_install_state(
            options,
            failure_state,
            failure_hresult,
            failure_reason);
        append_handoff_log(
            options.log_path,
            "finalizer-failed",
            failure_state,
            failure_hresult,
            failure_reason);
        if (options.mode == L"manual")
        {
            activate_store_application_with_retry(options, "failed");
        }
        return 2;
    }

    IVector<StorePackageUpdate> copy_updates(const IVectorView<StorePackageUpdate>& updates)
    {
        auto result = single_threaded_vector<StorePackageUpdate>();
        for (const auto& update : updates)
        {
            result.Append(update);
        }
        return result;
    }

    void initialize_owner_window(const StoreContext& context, HWND owner)
    {
        if (!owner || !IsWindow(owner))
        {
            throw hresult_invalid_argument(L"A valid Electron owner window is required for this operation");
        }
        check_hresult(context.as<::IInitializeWithWindow>()->Initialize(owner));
    }

    void emit_progress(const StorePackageUpdateStatus& status)
    {
        const auto percent = std::clamp(status.TotalDownloadProgress * 100.0, 0.0, 100.0);
        std::ostringstream output;
        output << "{\"type\":\"progress\""
               << ",\"state\":\"" << update_state_name(status.PackageUpdateState) << "\""
               << ",\"transferredBytes\":" << status.PackageBytesDownloaded
               << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
               << ",\"percent\":" << std::fixed << std::setprecision(2) << percent
               << "}";
        write_json_line(output.str());
    }

    void emit_result(const StorePackageUpdateResult& result)
    {
        std::ostringstream output;
        output << "{\"type\":\"result\""
               << ",\"state\":\"" << update_state_name(result.OverallState()) << "\""
               << ",\"packages\":[";
        bool first = true;
        for (const auto& status : result.StorePackageUpdateStatuses())
        {
            if (!first)
            {
                output << ',';
            }
            first = false;
            output << "{\"family\":\"" << escape_json(to_string(status.PackageFamilyName)) << "\""
                   << ",\"state\":\"" << update_state_name(status.PackageUpdateState) << "\""
                   << ",\"transferredBytes\":" << status.PackageBytesDownloaded
                   << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
                   << "}";
        }
        output << "]}";
        write_json_line(output.str());
    }

    IAsyncOperation<StorePackageUpdateResult> run_update_operation(
        StoreContext context,
        IVector<StorePackageUpdate> updates,
        Command command)
    {
        IAsyncOperationWithProgress<StorePackageUpdateResult, StorePackageUpdateStatus> operation{nullptr};
        switch (command)
        {
        case Command::DownloadSilent:
            operation = context.TrySilentDownloadStorePackageUpdatesAsync(updates);
            break;
        case Command::DownloadUser:
            operation = context.RequestDownloadStorePackageUpdatesAsync(updates);
            break;
        default:
            throw hresult_invalid_argument(L"Unsupported update operation");
        }

        operation.Progress([](const auto&, const StorePackageUpdateStatus& status)
        {
            emit_progress(status);
        });
        co_return co_await operation;
    }

    fire_and_forget execute(Command command, HWND owner)
    {
        try
        {
            if (command == Command::Identity)
            {
                const auto package_id = Package::Current().Id();
                std::ostringstream output;
                output << "{\"type\":\"identity\""
                       << ",\"aumid\":\"" << escape_json(current_application_user_model_id()) << "\""
                       << ",\"packageFamilyName\":\"" << escape_json(to_string(package_id.FamilyName())) << "\""
                       << ",\"currentPackageFullName\":\"" << escape_json(to_string(package_id.FullName())) << "\""
                       << ",\"currentPackageVersion\":\"" << escape_json(package_version(package_id.Version())) << "\""
                       << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            if (command == Command::StartupStatus ||
                command == Command::StartupEnable ||
                command == Command::StartupDisable)
            {
                const auto startup_task = co_await StartupTask::GetAsync(store_startup_task_id);
                StartupTaskState state = startup_task.State();
                if (command == Command::StartupEnable)
                {
                    state = co_await startup_task.RequestEnableAsync();
                }
                else if (command == Command::StartupDisable)
                {
                    startup_task.Disable();
                    state = startup_task.State();
                }

                std::ostringstream output;
                output << "{\"type\":\"startup-task\""
                       << ",\"taskId\":\"" << escape_json(to_string(startup_task.TaskId())) << "\""
                       << ",\"state\":\"" << startup_task_state_name(state) << "\""
                       << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            const auto context = StoreContext::GetDefault();
            if (command == Command::DownloadUser)
            {
                initialize_owner_window(context, owner);
            }

            const auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
            if (command == Command::Check)
            {
                bool mandatory = false;
                for (const auto& update : updates)
                {
                    mandatory = mandatory || update.Mandatory();
                }
                const auto package_id = Package::Current().Id();

                std::ostringstream output;
                output << "{\"type\":\"check\""
                       << ",\"available\":" << (updates.Size() > 0 ? "true" : "false")
                       << ",\"updateCount\":" << updates.Size()
                       << ",\"canSilentlyDownload\":"
                       << (context.CanSilentlyDownloadStorePackageUpdates() ? "true" : "false")
                       << ",\"mandatory\":" << (mandatory ? "true" : "false")
                       << ",\"currentPackageFullName\":\"" << escape_json(to_string(package_id.FullName())) << "\""
                       << ",\"currentPackageVersion\":\"" << escape_json(package_version(package_id.Version())) << "\"";
                output << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            if (updates.Size() == 0)
            {
                write_json_line("{\"type\":\"result\",\"state\":\"completed\",\"packages\":[]}");
                PostQuitMessage(0);
                co_return;
            }
            if (command == Command::DownloadSilent &&
                !context.CanSilentlyDownloadStorePackageUpdates())
            {
                write_json_line("{\"type\":\"result\",\"state\":\"not-allowed\",\"packages\":[]}");
                PostQuitMessage(0);
                co_return;
            }

            const auto result = co_await run_update_operation(context, copy_updates(updates), command);
            emit_result(result);
            PostQuitMessage(0);
        }
        catch (const hresult_error& error)
        {
            std::ostringstream output;
            output << "{\"type\":\"error\""
                   << ",\"hresult\":" << static_cast<int32_t>(error.code())
                   << ",\"message\":\"" << escape_json(to_string(error.message())) << "\""
                   << "}";
            write_json_line(output.str());
            PostQuitMessage(2);
        }
        catch (const std::exception& error)
        {
            write_json_line(
                "{\"type\":\"error\",\"hresult\":-1,\"message\":\"" +
                escape_json(error.what()) +
                "\"}");
            PostQuitMessage(2);
        }
    }

    fire_and_forget execute_store_install_handoff(
        StoreInstallHandoffOptions options,
        std::shared_ptr<memmy::StoreInstallShutdown> shutdown)
    {
        try
        {
            const auto context = StoreContext::GetDefault();
            const auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
            append_handoff_log(
                options.log_path,
                "store-updates-found",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                    "; updateCount=" + std::to_string(updates.Size()));
            if (updates.Size() == 0)
            {
                write_store_install_result(
                    options,
                    "no-update",
                    "",
                    "The Microsoft Store returned no update for the baseline package");
                PostQuitMessage(2);
                co_return;
            }

            append_handoff_log(
                options.log_path,
                "install-operation-started",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version));
            auto operation = context.TrySilentDownloadAndInstallStorePackageUpdatesAsync(
                copy_updates(updates));
            operation.Progress([log_path = options.log_path, package_family = options.package_family_name, shutdown](
                const auto&,
                const StorePackageUpdateStatus& status)
            {
                if (shutdown && status.PackageUpdateState == StorePackageUpdateState::Deploying &&
                    status.PackageFamilyName == package_family)
                {
                    shutdown->deployment_started();
                }
                append_store_package_log(log_path, "install-progress", status);
            });
            const StorePackageUpdateResult result = co_await operation;
            const std::string state = update_state_name(result.OverallState());
            for (const auto& status : result.StorePackageUpdateStatuses())
            {
                append_store_package_log(options.log_path, "install-package-result", status);
            }
            emit_result(result);
            write_store_install_result(
                options,
                state,
                "",
                state == "completed"
                    ? ""
                    : "The Microsoft Store silent install did not complete");
            PostQuitMessage(state == "completed" ? 0 : 2);
        }
        catch (const hresult_error& error)
        {
            const std::string code = hresult_text(error.code());
            const std::string reason = single_line(to_string(error.message()));
            try
            {
                write_store_install_result(options, "exception", code, reason);
            }
            catch (...)
            {
            }
            PostQuitMessage(2);
        }
        catch (const std::exception& error)
        {
            const std::string reason = single_line(error.what());
            try
            {
                write_store_install_result(options, "exception", "0xFFFFFFFF", reason);
            }
            catch (...)
            {
            }
            PostQuitMessage(2);
        }
    }

    Command parse_command(const std::wstring& value)
    {
        if (value == L"identity")
        {
            return Command::Identity;
        }
        if (value == L"package-family-registration")
        {
            return Command::PackageFamilyRegistration;
        }
        if (value == L"check")
        {
            return Command::Check;
        }
        if (value == L"download-silent")
        {
            return Command::DownloadSilent;
        }
        if (value == L"download-user")
        {
            return Command::DownloadUser;
        }
        if (value == L"handoff-install")
        {
            return Command::HandoffInstall;
        }
        if (value == L"launch-store-update-finalizer")
        {
            return Command::LaunchStoreUpdateFinalizer;
        }
        if (value == L"finalize-store-update")
        {
            return Command::FinalizeStoreUpdate;
        }
        if (value == L"startup-status")
        {
            return Command::StartupStatus;
        }
        if (value == L"startup-enable")
        {
            return Command::StartupEnable;
        }
        if (value == L"startup-disable")
        {
            return Command::StartupDisable;
        }
        if (value == L"prepare-legacy-takeover")
        {
            return Command::PrepareLegacyTakeover;
        }
        if (value == L"stop-legacy-for-data-import") return Command::StopLegacyForDataImport;
        if (value == L"create-store-shortcut") return Command::CreateStoreShortcut;
        if (value == L"discover-legacy-installation") return Command::DiscoverLegacyInstallation;
        if (value == L"launch-discovered-legacy-cleanup") return Command::LaunchDiscoveredLegacyCleanup;
        if (value == L"run-discovered-legacy-cleanup") return Command::RunDiscoveredLegacyCleanup;
        if (value == L"recover-legacy-cleanup-journal") return Command::RecoverLegacyCleanupJournal;
        if (value == L"ensure-legacy-cleanup-broker")
        {
            return Command::EnsureLegacyCleanupBroker;
        }
        if (value == L"legacy-cleanup-broker")
        {
            return Command::LegacyCleanupBroker;
        }
        if (value == L"stop-legacy-cleanup-broker")
        {
            return Command::StopLegacyCleanupBroker;
        }
        if (value == L"authorize-nsis-mutation")
        {
            return Command::AuthorizeNsisMutation;
        }
        if (value == L"finalize-legacy-cleanup")
        {
            return Command::FinalizeLegacyCleanup;
        }
        if (value == L"ack-legacy-cleanup")
        {
            return Command::AckLegacyCleanup;
        }
        if (value == L"finalize-legacy-cleanup-breakaway-launcher")
        {
            return Command::FinalizeLegacyCleanupBreakawayLauncher;
        }
        if (value == L"finalize-legacy-cleanup-unpackaged")
        {
            return Command::FinalizeLegacyCleanupUnpackaged;
        }
        throw hresult_invalid_argument(L"Unknown command");
    }

    bool is_legacy_transition_command(Command command)
    {
        return command == Command::PrepareLegacyTakeover ||
            command == Command::StopLegacyForDataImport || command == Command::CreateStoreShortcut ||
            command == Command::DiscoverLegacyInstallation || command == Command::LaunchDiscoveredLegacyCleanup ||
            command == Command::RunDiscoveredLegacyCleanup ||
            command == Command::RecoverLegacyCleanupJournal ||
            command == Command::EnsureLegacyCleanupBroker ||
            command == Command::LegacyCleanupBroker ||
            command == Command::StopLegacyCleanupBroker ||
            command == Command::AuthorizeNsisMutation ||
            command == Command::FinalizeLegacyCleanup ||
            command == Command::AckLegacyCleanup ||
            command == Command::FinalizeLegacyCleanupBreakawayLauncher ||
            command == Command::FinalizeLegacyCleanupUnpackaged;
    }

    bool is_legacy_cleanup_diagnostic_command(Command command)
    {
        return command == Command::FinalizeLegacyCleanup ||
            command == Command::AckLegacyCleanup ||
            command == Command::FinalizeLegacyCleanupBreakawayLauncher ||
            command == Command::FinalizeLegacyCleanupUnpackaged;
    }

    bool has_handoff_options(const StoreInstallHandoffOptions& options)
    {
        return !options.external_helper_path.empty() ||
            !options.state_path.empty() ||
            !options.result_path.empty() ||
            !options.log_path.empty() ||
            options.old_process_id != 0 ||
            !options.baseline_package_version.empty() ||
            !options.baseline_package_full_name.empty() ||
            !options.created_at.empty() ||
            !options.aumid.empty() ||
            !options.package_family_name.empty() ||
            !options.mode.empty();
    }

    int run_message_loop()
    {
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0)
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return static_cast<int>(message.wParam);
    }
}

int wmain(int argc, wchar_t* argv[])
{
    std::optional<Command> active_command;
    try
    {
        if (argc < 2)
        {
            std::cerr << "usage: MemmyStoreUpdate.exe <identity|package-family-registration|check|download-silent|download-user|handoff-install|launch-store-update-finalizer|finalize-store-update|startup-status|startup-enable|startup-disable|prepare-legacy-takeover|recover-legacy-cleanup-journal|ensure-legacy-cleanup-broker|legacy-cleanup-broker|stop-legacy-cleanup-broker|authorize-nsis-mutation|finalize-legacy-cleanup|ack-legacy-cleanup> [options]\n";
            return 64;
        }

        const Command command = parse_command(argv[1]);
        active_command = command;
        HWND owner = nullptr;
        StoreInstallHandoffOptions options;
        LegacyTransitionOptions legacy_options;
        std::wstring registration_package_family_name;
        bool store_only_option_was_provided = false;
        for (int index = 2; index < argc; ++index)
        {
            const std::wstring argument = argv[index];
            const auto require_value = [&]() -> const wchar_t*
            {
                if (index + 1 >= argc)
                {
                    throw hresult_invalid_argument(L"Command option is missing its value");
                }
                return argv[++index];
            };

            if (command == Command::PackageFamilyRegistration)
            {
                if (argument != L"--package-family-name")
                {
                    throw hresult_invalid_argument(
                        L"Package-family registration accepts only --package-family-name");
                }
                if (!registration_package_family_name.empty())
                {
                    throw hresult_invalid_argument(
                        L"--package-family-name may be specified only once");
                }
                registration_package_family_name = require_value();
                if (registration_package_family_name.empty())
                {
                    throw hresult_invalid_argument(L"Package family name is required");
                }
                continue;
            }

            if (argument == L"--hwnd")
            {
                store_only_option_was_provided = true;
                owner = parse_window_handle(require_value());
                continue;
            }
            if (argument == L"--external-helper-path")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.external_helper_path = require_value();
                }
                else
                {
                    options.external_helper_path = require_value();
                }
                continue;
            }
            if (argument == L"--legacy-install-directory")
            {
                legacy_options.legacy_install_directory = require_value();
                continue;
            }
            if (argument == L"--legacy-install-fingerprint")
            {
                if (command != Command::LaunchDiscoveredLegacyCleanup && command != Command::RunDiscoveredLegacyCleanup)
                    throw hresult_invalid_argument(L"Installation fingerprint is only valid for discovered cleanup");
                legacy_options.legacy_install_fingerprint = require_value();
                continue;
            }
            if (argument == L"--legacy-executable-path")
            {
                legacy_options.legacy_executable_path = require_value();
                continue;
            }
            if (argument == L"--shortcut")
            {
                legacy_options.shortcut_path = require_value();
                continue;
            }
            if (argument == L"--state-path")
            {
                store_only_option_was_provided = true;
                options.state_path = require_value();
                continue;
            }
            if (argument == L"--result-path")
            {
                store_only_option_was_provided = true;
                options.result_path = require_value();
                continue;
            }
            if (argument == L"--log-path")
            {
                store_only_option_was_provided = true;
                options.log_path = require_value();
                continue;
            }
            if (argument == L"--old-pid")
            {
                store_only_option_was_provided = true;
                options.old_process_id = parse_process_id(require_value());
                continue;
            }
            if (argument == L"--baseline-package-version")
            {
                store_only_option_was_provided = true;
                options.baseline_package_version = require_value();
                continue;
            }
            if (argument == L"--baseline-package-full-name")
            {
                store_only_option_was_provided = true;
                options.baseline_package_full_name = require_value();
                continue;
            }
            if (argument == L"--created-at")
            {
                store_only_option_was_provided = true;
                options.created_at = require_value();
                continue;
            }
            if (argument == L"--aumid")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.aumid = require_value();
                }
                else
                {
                    options.aumid = require_value();
                }
                continue;
            }
            if (argument == L"--package-family-name")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.package_family_name = require_value();
                }
                else
                {
                    options.package_family_name = require_value();
                }
                continue;
            }
            if (argument == L"--transition-id")
            {
                if (!is_legacy_transition_command(command))
                {
                    throw hresult_invalid_argument(
                        L"--transition-id is only valid for legacy cleanup");
                }
                legacy_options.transition_id = require_value();
                continue;
            }
            if (argument == L"--attempt-id")
            {
                if (!is_legacy_transition_command(command))
                {
                    throw hresult_invalid_argument(
                        L"--attempt-id is only valid for legacy cleanup");
                }
                legacy_options.attempt_id = require_value();
                continue;
            }
            if (argument == L"--mode")
            {
                store_only_option_was_provided = true;
                options.mode = require_value();
                continue;
            }
            throw hresult_invalid_argument(L"Unknown argument");
        }

        if (command == Command::PackageFamilyRegistration)
        {
            if (!is_valid_package_family_name(registration_package_family_name))
            {
                throw hresult_invalid_argument(
                    L"package-family-registration requires a valid --package-family-name");
            }
            emit_package_family_registration(registration_package_family_name);
            return 0;
        }
        if (is_legacy_transition_command(command) &&
            (store_only_option_was_provided || owner != nullptr || has_handoff_options(options)))
        {
            throw hresult_invalid_argument(
                L"Legacy transition commands do not accept Store handoff or UI options");
        }

        init_apartment(apartment_type::single_threaded);
        if (command == Command::DiscoverLegacyInstallation)
        {
            if (argc != 2) throw hresult_invalid_argument(L"Legacy installation discovery accepts no options");
            emit_discovered_legacy_installation();
            return 0;
        }
        if (command == Command::LaunchDiscoveredLegacyCleanup || command == Command::RunDiscoveredLegacyCleanup)
        {
            if (command == Command::LaunchDiscoveredLegacyCleanup) launch_discovered_legacy_cleanup(legacy_options);
            else run_discovered_legacy_cleanup(legacy_options);
            return 0;
        }
        if (command == Command::StopLegacyForDataImport)
        {
            if (argc != 2) throw hresult_invalid_argument(L"Data import process shutdown accepts no options");
            const bool clear = stop_legacy_for_data_import();
            std::cout << "{\"status\":\"" << (clear ? "clear" : "blocked") << "\"}\n";
            return 0;
        }
        if (command == Command::CreateStoreShortcut)
        {
            if (argc != 6 || !is_valid_aumid(legacy_options.aumid) ||
                legacy_options.aumid != legacy_options.package_family_name + L"!Memmy")
                throw hresult_invalid_argument(L"Store shortcut identity is invalid");
            create_store_shortcut(legacy_options);
            return 0;
        }
        if (command == Command::RecoverLegacyCleanupJournal)
        {
            if (argc != 2)
            {
                throw hresult_invalid_argument(L"Orphan cleanup journal recovery accepts no options");
            }
            const bool recovered = recover_orphaned_cleanup_journal();
            std::cout << "{\"status\":\"" << (recovered ? "recovered" : "no-journal") << "\"}\n";
            return 0;
        }
        if (command == Command::EnsureLegacyCleanupBroker ||
            command == Command::LegacyCleanupBroker)
        {
            if (!legacy_options.external_helper_path.empty() ||
                !legacy_options.legacy_install_directory.empty() ||
                !legacy_options.legacy_executable_path.empty() ||
                !legacy_options.shortcut_path.empty() ||
                !legacy_options.aumid.empty() ||
                !legacy_options.transition_id.empty() ||
                !legacy_options.attempt_id.empty())
            {
                throw hresult_invalid_argument(L"Cleanup broker command arguments are invalid");
            }
            if (command == Command::EnsureLegacyCleanupBroker)
            {
                ensure_legacy_cleanup_broker(legacy_options.package_family_name);
                return 0;
            }
            return run_legacy_cleanup_broker(legacy_options.package_family_name);
        }
        if (command == Command::StopLegacyCleanupBroker)
        {
            if (!legacy_options.external_helper_path.empty() ||
                !legacy_options.legacy_install_directory.empty() ||
                !legacy_options.legacy_executable_path.empty() ||
                !legacy_options.shortcut_path.empty() ||
                !legacy_options.aumid.empty() ||
                !legacy_options.package_family_name.empty() ||
                !legacy_options.transition_id.empty() ||
                !legacy_options.attempt_id.empty())
            {
                throw hresult_invalid_argument(L"Cleanup broker shutdown accepts no options");
            }
            stop_legacy_cleanup_broker();
            return 0;
        }
        if (command == Command::AuthorizeNsisMutation)
        {
            if (!legacy_options.external_helper_path.empty() ||
                !legacy_options.legacy_install_directory.empty() ||
                !legacy_options.legacy_executable_path.empty() ||
                !legacy_options.shortcut_path.empty() ||
                !legacy_options.aumid.empty() ||
                !legacy_options.package_family_name.empty() ||
                !legacy_options.transition_id.empty() ||
                !legacy_options.attempt_id.empty())
            {
                throw hresult_invalid_argument(L"NSIS mutation authorization accepts no options");
            }
            authorize_nsis_mutation();
            return 0;
        }
        if (command == Command::PrepareLegacyTakeover)
        {
            validate_legacy_transition_options(legacy_options, false, false);
            if (!legacy_options.external_helper_path.empty() ||
                !legacy_options.shortcut_path.empty() ||
                !legacy_options.aumid.empty() ||
                !legacy_options.package_family_name.empty() ||
                !legacy_options.transition_id.empty() ||
                !legacy_options.attempt_id.empty())
            {
                throw hresult_invalid_argument(L"Legacy takeover arguments are invalid");
            }
            prepare_legacy_takeover(legacy_options);
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanup)
        {
            initialize_legacy_cleanup_diagnostics(legacy_options, "packaged-helper");
            begin_legacy_cleanup_operation("options-validate");
            validate_legacy_transition_options(legacy_options, true, false);
            if (!legacy_options.external_helper_path.empty())
            {
                throw hresult_invalid_argument(
                    L"Brokered legacy cleanup does not accept an external helper path");
            }
            require_allowed_memmy_package_identity(legacy_options);
            complete_legacy_cleanup_operation();
            begin_legacy_cleanup_operation(
                "identity-query",
                utf8(current_executable_path().wstring()));
            if (!current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup entry point must retain application package identity");
            }
            const auto package_family = process_package_family(GetCurrentProcess());
            if (!package_family ||
                *package_family != legacy_options.package_family_name ||
                process_application_user_model_id(GetCurrentProcess()) != legacy_options.aumid)
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup entry point package identity does not match its request");
            }
            complete_legacy_cleanup_operation("requiredPackageIdentity=true; identityMatchesRequest=true");
            finalize_legacy_cleanup_via_broker(legacy_options);
            append_legacy_cleanup_diagnostic("process-complete", "success");
            return 0;
        }
        if (command == Command::AckLegacyCleanup)
        {
            initialize_legacy_cleanup_diagnostics(legacy_options, "packaged-helper-ack");
            begin_legacy_cleanup_operation("ack-options-validate");
            validate_legacy_transition_options(legacy_options, true, false);
            if (!legacy_options.external_helper_path.empty())
            {
                throw hresult_invalid_argument(
                    L"Brokered legacy cleanup acknowledgement does not accept an external helper path");
            }
            require_allowed_memmy_package_identity(legacy_options);
            complete_legacy_cleanup_operation();
            begin_legacy_cleanup_operation(
                "ack-identity-query",
                utf8(current_executable_path().wstring()));
            if (!current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup acknowledgement must retain application package identity");
            }
            const auto package_family = process_package_family(GetCurrentProcess());
            if (!package_family ||
                *package_family != legacy_options.package_family_name ||
                process_application_user_model_id(GetCurrentProcess()) != legacy_options.aumid)
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup acknowledgement identity does not match its request");
            }
            complete_legacy_cleanup_operation("requiredPackageIdentity=true; identityMatchesRequest=true");
            acknowledge_legacy_cleanup_via_broker(legacy_options);
            append_legacy_cleanup_diagnostic("process-complete", "success");
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanupBreakawayLauncher)
        {
            initialize_legacy_cleanup_diagnostics(legacy_options, "breakaway-launcher");
            set_legacy_cleanup_failure_context(
                "deprecated-cleanup-entry-point",
                "finalize-legacy-cleanup-breakaway-launcher",
                ERROR_NOT_SUPPORTED);
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED),
                L"Breakaway legacy cleanup is disabled; use the pre-established native broker");
        }
        if (command == Command::FinalizeLegacyCleanupUnpackaged)
        {
            initialize_legacy_cleanup_diagnostics(
                legacy_options,
                "external-unpackaged-helper");
            set_legacy_cleanup_failure_context(
                "deprecated-cleanup-entry-point",
                "finalize-legacy-cleanup-unpackaged",
                ERROR_NOT_SUPPORTED);
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED),
                L"Direct unpackaged legacy cleanup is disabled; use the pre-established native broker");
        }
        if (command == Command::HandoffInstall)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store install handoff");
            }
            validate_store_install_handoff_options(options, true);
            if (!current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Store update installer must retain application package identity");
            }
            try
            {
                launch_store_update_finalizer_breakaway(options);
            }
            catch (const hresult_error& error)
            {
                const std::string code = hresult_text(error.code());
                const std::string reason = single_line(to_string(error.message()));
                write_store_install_result(options, "finalizer-start-failed", code, reason);
                write_failed_store_install_state(
                    options,
                    "finalizer-start-failed",
                    code,
                    reason);
                try
                {
                    wait_for_old_application_exit(options);
                    if (options.mode == L"manual")
                    {
                        activate_store_application_with_retry(
                            options,
                            "finalizer-start-failed");
                    }
                }
                catch (...)
                {
                }
                return 2;
            }
            std::shared_ptr<memmy::StoreInstallShutdown> shutdown;
            try
            {
                shutdown = std::make_shared<memmy::StoreInstallShutdown>([options](const char* reason) {
                    append_handoff_log(options.log_path, "installer-release-for-deployment", utf8(options.mode), "", reason);
                });
                append_handoff_log(
                    options.log_path, "installer-shutdown-ready", utf8(options.mode),
                    shutdown->window_error() ? hresult_text(HRESULT_FROM_WIN32(shutdown->window_error())) : "",
                    shutdown->window() ? "window-and-bounded-timeouts" : "bounded-timeouts-only");
            }
            catch (const std::exception& error)
            {
                // Do not start an unbounded Store operation without the timer.
                // The external finalizer restores the retryable state and, for
                // a manual update, reopens the currently installed application.
                report_store_install_shutdown_unavailable(options, error.what());
                return 2;
            }
            append_handoff_log(
                options.log_path,
                "handoff-installer-started",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                    "; oldPid=" + std::to_string(options.old_process_id));
            try
            {
                wait_for_old_application_exit(options);
            }
            catch (const hresult_error& error)
            {
                write_store_install_result(
                    options,
                    "old-process-exit-failed",
                    hresult_text(error.code()),
                    single_line(to_string(error.message())));
                return 2;
            }
            execute_store_install_handoff(options, shutdown);
            const int exit_code = run_message_loop();
            shutdown->finish();
            return exit_code;
        }

        if (command == Command::LaunchStoreUpdateFinalizer)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store update finalization");
            }
            validate_store_install_handoff_options(options, true);
            launch_external_store_update_finalizer(options);
            return 0;
        }

        if (command == Command::FinalizeStoreUpdate)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store update finalization");
            }
            validate_store_install_handoff_options(options, false);
            return finalize_store_update(options);
        }

        if (has_handoff_options(options))
        {
            throw hresult_invalid_argument(L"Store install handoff arguments are invalid for this command");
        }
        if (owner != nullptr && command != Command::DownloadUser)
        {
            throw hresult_invalid_argument(L"--hwnd is only valid for download-user");
        }

        execute(command, owner);
        return run_message_loop();
    }
    catch (const hresult_error& error)
    {
        const std::string message = to_string(error.message());
        write_legacy_cleanup_process_failure(error.code(), message);
        write_legacy_cleanup_error_to_stderr(error.code(), message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(error.code())
            : 2;
    }
    catch (const std::filesystem::filesystem_error& error)
    {
        const DWORD win32_error = static_cast<DWORD>(error.code().value());
        const HRESULT hresult = HRESULT_FROM_WIN32(win32_error);
        const std::string target = !error.path1().empty()
            ? utf8(error.path1().wstring())
            : (!error.path2().empty() ? utf8(error.path2().wstring()) : "");
        set_legacy_cleanup_failure_context(
            "std::filesystem",
            target,
            win32_error);
        const std::string message = error.what();
        write_legacy_cleanup_process_failure(hresult, message);
        write_legacy_cleanup_error_to_stderr(hresult, message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(hresult)
            : 2;
    }
    catch (const std::exception& error)
    {
        const HRESULT hresult = static_cast<HRESULT>(-1);
        const std::string message = error.what();
        write_legacy_cleanup_process_failure(hresult, message);
        write_legacy_cleanup_error_to_stderr(hresult, message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(hresult)
            : 2;
    }
}
