#pragma once

#include "common/cli.h"

namespace memmy::win {

int RunWindows(const cli::CommandLine& command);
int RunApplications();
int RunCatalog();
int RunSnapshot(const cli::CommandLine& command);
int RunObserve(const cli::CommandLine& command);

}  // namespace memmy::win
