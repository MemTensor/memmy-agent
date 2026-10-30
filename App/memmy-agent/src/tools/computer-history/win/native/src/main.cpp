#include "common/cli.h"
#include "win/commands.h"
#include "win/system.h"
#include "win/uia_reader.h"
#include "win/task_video.h"

#include <windows.h>
#include <crtdbg.h>

#include <new>
#include <string>
#include <vector>

#ifndef MEMMY_HISTORY_TEST_HOOKS
#error MEMMY_HISTORY_TEST_HOOKS must be defined to 0 or 1 by the build
#endif

int wmain(int argc, wchar_t** argv) {
  // Physical-pixel coordinates for window bounds and UIA rectangles.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  // Do not let a crash pop a dialog that would keep a hung worker or collector alive.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#ifdef _DEBUG
  // Debug CRT asserts go to stderr instead of a modal dialog.
  for (const int type : {_CRT_WARN, _CRT_ERROR, _CRT_ASSERT}) {
    _CrtSetReportMode(type, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(type, _CRTDBG_FILE_STDERR);
  }
#endif

  std::vector<std::wstring> args;
  for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
  const auto parsed = memmy::cli::Parse(args, MEMMY_HISTORY_TEST_HOOKS != 0);
  if (!parsed.command) {
    memmy::win::Diagnostic("usage_error", parsed.error);
    return 2;
  }
  const memmy::cli::CommandLine& command = *parsed.command;
  try {
    switch (command.kind) {
      case memmy::cli::CommandKind::Help:
        return memmy::win::WriteStdout(memmy::cli::UsageText()) ? 0 : 6;
      case memmy::cli::CommandKind::Version: {
        std::string version = std::string("memmy-history-recorder ") + MEMMY_HISTORY_RECORDER_VERSION +
                              " protocol 1" + (MEMMY_HISTORY_TEST_HOOKS ? " test-hooks" : "") + "\n";
        return memmy::win::WriteStdout(version) ? 0 : 6;
      }
      case memmy::cli::CommandKind::Windows:
        return memmy::win::RunWindows(command);
      case memmy::cli::CommandKind::Applications:
        return memmy::win::RunApplications();
      case memmy::cli::CommandKind::Catalog:
        return memmy::win::RunCatalog();
      case memmy::cli::CommandKind::Snapshot:
        return memmy::win::RunSnapshot(command);
      case memmy::cli::CommandKind::Observe:
      case memmy::cli::CommandKind::RecordTask:
        return memmy::win::RunObserve(command);
      case memmy::cli::CommandKind::FinalizeTask:
        return memmy::win::TaskVideo::Finalize(command.outputDirectory);
      case memmy::cli::CommandKind::ExportTaskFrames:
        return memmy::win::TaskVideo::ExportFrames(command.outputDirectory, command.exportDirectory);
      case memmy::cli::CommandKind::Worker:
        return memmy::win::WorkerMain();
    }
  } catch (const std::bad_alloc&) {
    memmy::win::Diagnostic("out_of_memory");
  } catch (...) {
    memmy::win::Diagnostic("internal_error");
  }
  return 1;
}
