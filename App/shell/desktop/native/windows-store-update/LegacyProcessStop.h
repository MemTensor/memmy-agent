#pragma once

#include <cstdint>

namespace memmy
{
    // A process can disappear during inspection or termination. Only fresh,
    // consecutive empty scans establish that data is no longer in use.
    template<class Discover, class Stop, class Now, class Pause, class Report>
    bool stop_legacy_until_clear(Discover discover, Stop stop, Now now, Pause pause,
        Report report, std::uint64_t timeout_ms)
    {
        const auto deadline = now() + timeout_ms;
        int empty_rounds = 0;
        while (now() < deadline)
        {
            try
            {
                const auto targets = discover();
                if (targets.empty())
                {
                    if (++empty_rounds == 3) return true;
                }
                else
                {
                    empty_rounds = 0;
                    stop(targets, deadline);
                }
            }
            catch (...)
            {
                empty_rounds = 0;
                // Report and re-enumerate instead of treating a process-exit race
                // as proof that the old application is still running.
                report();
            }
            const auto current = now();
            if (current >= deadline) break;
            const auto remaining = deadline - current;
            pause(remaining < 150 ? remaining : 150);
        }
        return false;
    }
}
