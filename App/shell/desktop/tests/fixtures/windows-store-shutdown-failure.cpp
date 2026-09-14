// Compile the real native recovery code; never invoke its application entrypoint
// or Store APIs. All processes and result files below belong to this fixture.
#define wmain memmy_store_helper_entrypoint
#include "MemmyStoreUpdate.cpp"
#undef wmain

int wmain(int argc, wchar_t* argv[])
{
    if (argc == 2 && std::wstring(argv[1]) == L"old-instance") { Sleep(600); return 0; }
    if (argc != 3) return 2;
    StoreInstallHandoffOptions options;
    options.mode = argv[1];
    options.result_path = std::filesystem::path(argv[2]) / L"result.json";
    options.log_path = std::filesystem::path(argv[2]) / L"handoff.log";
    wchar_t executable[32768]{};
    if (!GetModuleFileNameW(nullptr, executable, 32768)) return 3;
    std::wstring command = L"\"" + std::wstring(executable) + L"\" old-instance";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, nullptr, &startup, &child)) return 4;
    CloseHandle(child.hThread);
    options.old_process_id = child.dwProcessId;
    std::atomic<bool> premature{false};
    std::thread observer([&] {
        while (WaitForSingleObject(child.hProcess, 5) == WAIT_TIMEOUT)
        {
            if (read_store_install_result(options.result_path).available
                && WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT) premature = true;
        }
    });
    const auto start = GetTickCount64();
    try { throw std::runtime_error("injected watchdog construction failure"); }
    catch (const std::exception& error) { report_store_install_shutdown_unavailable(options, error.what()); }
    observer.join();
    const bool exited = WaitForSingleObject(child.hProcess, 0) == WAIT_OBJECT_0;
    CloseHandle(child.hProcess);
    const auto result = read_store_install_result(options.result_path);
    if (premature || !exited || !result.available || result.state != "installer-shutdown-unavailable") return 5;
    std::cout << "recovery-after-old-exit mode=" << utf8(options.mode)
        << " elapsed=" << GetTickCount64() - start << std::endl;
    return 0;
}
