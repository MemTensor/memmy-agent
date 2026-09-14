#include "LegacyProcessStop.h"
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

int main(int argc, char** argv)
{
    if (argc != 2) return 2;
    const std::string scenario = argv[1];
    std::uint64_t clock = 0;
    int scans = 0, stops = 0, errors = 0;
    bool active = true;
    const bool clear = memmy::stop_legacy_until_clear(
        [&]() -> std::vector<int> {
            ++scans;
            if (scenario == "access-denied") throw std::runtime_error("access denied");
            if (scenario == "inspection-race" && scans == 2) throw std::runtime_error("process exited during token query");
            if (scenario == "child-restarts") return scans == 1 || scans == 4 ? std::vector<int>{123} : std::vector<int>{};
            return active ? std::vector<int>{123} : std::vector<int>{};
        },
        [&](const auto&, std::uint64_t deadline) {
            if (deadline != 25'000) throw std::runtime_error("incorrect global deadline");
            ++stops;
            if (scenario == "permanent-worker") { clock = (std::min)(clock + 3000, deadline); return; }
            active = false;
            if (scenario == "termination-race") throw std::runtime_error("child already terminated by its parent");
        },
        [&] { return clock; },
        [&](std::uint64_t duration) { clock += duration; },
        [&] { ++errors; }, 25'000);

    bool passed = false;
    if (scenario == "inspection-race") passed = clear && stops == 1 && scans == 5 && errors == 1;
    if (scenario == "termination-race") passed = clear && stops == 1 && scans == 4 && errors == 1;
    if (scenario == "child-restarts") passed = clear && stops == 2 && scans == 7;
    if (scenario == "access-denied") passed = !clear && stops == 0 && errors > 1 && clock == 25'000;
    if (scenario == "permanent-worker") passed = !clear && stops > 1 && clock == 25'000;
    std::cout << "clear=" << clear << " scans=" << scans << " stops=" << stops
        << " errors=" << errors << " elapsed=" << clock << '\n';
    return passed ? 0 : 1;
}
