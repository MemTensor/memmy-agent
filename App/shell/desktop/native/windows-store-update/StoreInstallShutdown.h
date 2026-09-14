#pragma once

#include <windows.h>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace memmy
{
    // Only the packaged handoff installer owns this object. Migration/cleanup
    // commands and the unpackaged finalizer must never participate in this exit.
    class StoreInstallShutdown
    {
    public:
        static constexpr wchar_t window_class_name[] = L"Memmy.StoreInstallShutdown";
        static constexpr DWORD deployment_grace_ms = 5000;
        // The external finalizer observes replacement for 15 minutes. Release
        // this package at least a minute earlier even if Store sends no events.
        static constexpr DWORD operation_timeout_ms = 14 * 60 * 1000;
        static constexpr DWORD diagnostic_grace_ms = 100;

        explicit StoreInstallShutdown(
            std::function<void(const char*)> before_exit,
            DWORD grace_ms = deployment_grace_ms,
            DWORD timeout_ms = operation_timeout_ms)
            : before_exit_(std::move(before_exit)), grace_ms_(grace_ms),
              operation_deadline_(std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms)),
              watchdog_([this] { watch(); })
        {
            WNDCLASSW window_class{};
            window_class.hInstance = GetModuleHandleW(nullptr);
            window_class.lpszClassName = window_class_name;
            window_class.lpfnWndProc = window_proc;
            owns_window_class_ = RegisterClassW(&window_class) != 0;
            if (!owns_window_class_ && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
            {
                window_error_ = GetLastError();
                return;
            }
            // A hidden top-level window receives shutdown broadcasts. HWND_MESSAGE
            // would not. Failure here must not disable the independent watchdog.
            window_ = CreateWindowExW(
                0, window_class_name, L"Memmy Store update", WS_OVERLAPPED,
                0, 0, 0, 0, nullptr, nullptr, window_class.hInstance, this);
            if (!window_)
            {
                window_error_ = GetLastError();
                if (window_error_ == ERROR_SUCCESS) window_error_ = ERROR_CANNOT_MAKE;
            }
        }

        StoreInstallShutdown(const StoreInstallShutdown&) = delete;
        StoreInstallShutdown& operator=(const StoreInstallShutdown&) = delete;

        ~StoreInstallShutdown()
        {
            finish();
            watchdog_.join();
            if (window_) DestroyWindow(window_);
            if (owns_window_class_) UnregisterClassW(window_class_name, GetModuleHandleW(nullptr));
        }

        HWND window() const noexcept { return window_; }
        DWORD window_error() const noexcept { return window_error_; }

        void deployment_started()
        {
            std::lock_guard lock(mutex_);
            if (finished_ || deployment_deadline_) return;
            // Start once, only after the Store confirms that this app's package
            // is deploying. Repeated progress must not extend the deadline.
            deployment_deadline_ = std::chrono::steady_clock::now() + std::chrono::milliseconds(grace_ms_);
            wake_.notify_one();
        }

        void finish()
        {
            std::lock_guard lock(mutex_);
            finished_ = true;
            wake_.notify_one();
        }

    private:
        static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
        {
            if (message == WM_NCCREATE)
            {
                const auto creation = reinterpret_cast<CREATESTRUCTW*>(lparam);
                SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
            }
            const auto self = reinterpret_cast<StoreInstallShutdown*>(GetWindowLongPtrW(window, GWLP_USERDATA));
            if (self)
            {
                if (message == WM_QUERYENDSESSION) return TRUE;
                if (message == WM_ENDSESSION)
                {
                    // A query or a cancelled shutdown is not permission to exit.
                    if (wparam) self->request_exit("wm-endsession");
                    return 0;
                }
                if (message == WM_CLOSE)
                {
                    self->request_exit("wm-close");
                    return 0;
                }
            }
            return DefWindowProcW(window, message, wparam, lparam);
        }

        void request_exit(const char* reason)
        {
            std::lock_guard lock(mutex_);
            if (finished_) return;
            exit_reason_ = reason;
            wake_.notify_one();
        }

        void watch()
        {
            std::unique_lock lock(mutex_);
            while (!finished_)
            {
                if (exit_reason_) break;
                const auto now = std::chrono::steady_clock::now();
                if (now >= operation_deadline_)
                {
                    exit_reason_ = "operation-timeout";
                    break;
                }
                if (deployment_deadline_ && now >= *deployment_deadline_)
                {
                    exit_reason_ = "deployment-timeout";
                    break;
                }
                wake_.wait_until(lock, deployment_deadline_ && *deployment_deadline_ < operation_deadline_
                    ? *deployment_deadline_ : operation_deadline_);
            }
            if (finished_) return;
            const char* reason = exit_reason_;
            lock.unlock();
            try
            {
                // Logging may block in filesystem I/O, not merely throw. Give it
                // a separate thread and a bounded best-effort flush interval.
                // Capture by value: the detached logger does not borrow this owner.
                std::thread diagnostic([callback = before_exit_, reason] {
                    try { callback(reason); } catch (...) { /* Best effort only. */ }
                });
                WaitForSingleObject(diagnostic.native_handle(), diagnostic_grace_ms);
                diagnostic.detach();
            }
            catch (...) { /* Even failure to create diagnostics must release the installer. */ }
            // Release only this expendable installer, including if its STA is
            // blocked. Do not clear the barrier or claim installation succeeded;
            // the existing external finalizer verifies actual package replacement.
            TerminateProcess(GetCurrentProcess(), 0);
            ExitProcess(0);
        }

        std::function<void(const char*)> before_exit_;
        DWORD grace_ms_;
        const std::chrono::steady_clock::time_point operation_deadline_;
        std::mutex mutex_;
        std::condition_variable wake_;
        bool finished_ = false;
        const char* exit_reason_ = nullptr;
        std::optional<std::chrono::steady_clock::time_point> deployment_deadline_;
        HWND window_ = nullptr;
        DWORD window_error_ = ERROR_SUCCESS;
        bool owns_window_class_ = false;
        std::thread watchdog_;
    };
}
