#include "StoreInstallShutdown.h"
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

namespace
{
    LRESULT CALLBACK reject_window(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
    {
        return message == WM_NCCREATE ? FALSE : DefWindowProcW(window, message, wparam, lparam);
    }

    void pump_for(ULONGLONG duration)
    {
        const auto deadline = GetTickCount64() + duration;
        while (GetTickCount64() < deadline)
        {
            MSG message{};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
            {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            Sleep(5);
        }
    }
}

int main(int argc, char** argv)
{
    if (argc != 2) return 2;
    const std::string scenario = argv[1];
    if (scenario == "window-creation-failed" || scenario == "all-notifications-lost-window-creation-failed")
    {
        WNDCLASSW rejecting{};
        rejecting.hInstance = GetModuleHandleW(nullptr);
        rejecting.lpszClassName = memmy::StoreInstallShutdown::window_class_name;
        rejecting.lpfnWndProc = reject_window;
        if (!RegisterClassW(&rejecting)) return 3;
    }
    const auto start = GetTickCount64();
    const auto before_exit = [&](const char* reason) {
        std::cout << "exit=" << reason << " elapsed=" << GetTickCount64() - start << std::endl;
        if (scenario == "logging-failed") throw std::runtime_error("diagnostic write failed");
        if (scenario == "logging-blocked" || scenario == "all-notifications-lost-logging-blocked") Sleep(INFINITE);
    };
    const bool total_timeout = scenario.starts_with("all-notifications-lost") || scenario == "deployment-after-total-deadline";
    const auto owner = scenario == "default-timeout"
        ? std::make_unique<memmy::StoreInstallShutdown>(before_exit)
        : std::make_unique<memmy::StoreInstallShutdown>(before_exit, total_timeout ? 1000 : 250,
            total_timeout ? 250 : memmy::StoreInstallShutdown::operation_timeout_ms);
    auto& shutdown = *owner;
    const HWND window = shutdown.window();
    if (scenario == "window-creation-failed" || scenario == "all-notifications-lost-window-creation-failed")
    {
        if (window || shutdown.window_error() == ERROR_SUCCESS) return 4;
    }
    else if (!window || IsWindowVisible(window) || GetParent(window)) return 5;

    if (scenario == "query-only" || scenario == "cancelled-shutdown")
    {
        if (SendMessageW(window, WM_QUERYENDSESSION, 0, ENDSESSION_CLOSEAPP) != TRUE) return 6;
        if (scenario == "cancelled-shutdown") SendMessageW(window, WM_ENDSESSION, FALSE, ENDSESSION_CLOSEAPP);
        pump_for(400);
        std::cout << "survived=" << scenario << std::endl;
        return 0;
    }
    if (scenario == "before-deployment")
    {
        pump_for(400);
        std::cout << "survived=before-deployment" << std::endl;
        return 0;
    }
    if (total_timeout)
    {
        if (scenario == "all-notifications-lost-operation-finished")
        {
            shutdown.finish();
            pump_for(400);
            std::cout << "survived=" << scenario << std::endl;
            return 0;
        }
        if (scenario == "deployment-after-total-deadline")
        {
            pump_for(100);
            shutdown.deployment_started();
        }
        // No Store progress, no window messages, or even a completely blocked STA.
        if (scenario == "all-notifications-lost-blocked-sta") Sleep(2000);
        else pump_for(2000);
        return 8;
    }
    if (scenario == "end-session") SendMessageW(window, WM_ENDSESSION, TRUE, ENDSESSION_CLOSEAPP);
    else if (scenario == "close") PostMessageW(window, WM_CLOSE, 0, 0);
    else shutdown.deployment_started();

    if (scenario == "operation-finished")
    {
        shutdown.finish();
        pump_for(400);
        std::cout << "survived=operation-finished" << std::endl;
        return 0;
    }
    if (scenario == "deadline-not-reset")
    {
        for (int i = 0; i < 20; ++i) { shutdown.deployment_started(); pump_for(50); }
    }
    if (scenario == "blocked-message-loop") Sleep(2000);
    else pump_for(scenario == "default-timeout" ? 7000 : 2000);
    std::cerr << "shutdown did not exit" << std::endl;
    return 7;
}
