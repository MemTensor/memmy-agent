// Compile the real native recovery code; never invoke its application entrypoint
// or Store APIs. All processes and result files below belong to this fixture.
#define wmain memmy_store_helper_entrypoint
#include "MemmyStoreUpdate.cpp"
#undef wmain

int wmain(int argc, wchar_t* argv[])
{
    if (argc == 2 && std::wstring(argv[1]) == L"old-instance") { Sleep(2000); return 0; }
    if (argc != 3) return 2;
    StoreInstallHandoffOptions options;
    options.mode = argv[1];
    options.attempt_id = L"11111111-1111-4111-8111-111111111111";
    options.created_at = L"2026-09-14T00:00:00.000Z";
    options.baseline_package_version = L"1.1.300.0";
    options.baseline_package_full_name = L"Memtensor.Memmy_1.1.300.0_x64__eyack96k521x2";
    const std::filesystem::path directory(argv[2]);
    options.state_path = directory / L"state.json";
    options.result_path = directory / L"result.json";
    options.log_path = directory / L"handoff.log";
    {
        std::ofstream state(options.state_path, std::ios::binary | std::ios::trunc);
        if (!state) return 3;
        state << "{\"schemaVersion\":2,\"attemptId\":\"11111111-1111-4111-8111-111111111111\",\"status\":\"handoff\"}";
    }
    wchar_t executable[32768]{};
    if (!GetModuleFileNameW(nullptr, executable, 32768)) return 4;
    std::wstring command = L"\"" + std::wstring(executable) + L"\" old-instance";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, nullptr, &startup, &child)) return 5;
    CloseHandle(child.hThread);
    options.old_process_id = child.dwProcessId;
    const auto start = GetTickCount64();
    try { throw std::runtime_error("injected watchdog construction failure"); }
    catch (const std::exception& error) { report_store_install_shutdown_unavailable(options, error.what()); }
    const auto report_elapsed = GetTickCount64() - start;
    const bool old_process_still_running = WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT;
    const auto result = read_store_install_result(options);
    std::ifstream state_input(options.state_path, std::ios::binary);
    const std::string state_contents{
        std::istreambuf_iterator<char>(state_input),
        std::istreambuf_iterator<char>()};
    if (old_process_still_running)
    {
        TerminateProcess(child.hProcess, 0);
    }
    WaitForSingleObject(child.hProcess, 3000);
    CloseHandle(child.hProcess);
    if (!old_process_still_running || !result.available ||
        result.state != "installer-shutdown-unavailable" ||
        state_contents.find("\"status\": \"failed\"") == std::string::npos ||
        state_contents.find(utf8(options.attempt_id)) == std::string::npos) return 6;
    std::cout << "failure-published-with-old-running mode=" << utf8(options.mode)
        << " reportElapsed=" << report_elapsed << std::endl;
    return 0;
}
