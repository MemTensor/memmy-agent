#pragma once
#include <cstdint>
#include <memory>
#include <string>

namespace memmy::win {
class HookThread;
// The observer owns the only hook/UIA process; this worker owns only WGC and encoding.
class TaskVideo {
 public:
  TaskVideo(std::wstring directory, std::wstring policy, HookThread& hooks, std::uint64_t origin, unsigned seconds);
  ~TaskVideo();
  bool Start();
  void Pause(bool paused);
  void Stop();
  bool Failed() const;
  bool Done() const;
  static int Finalize(const std::wstring& directory);
  static int ExportFrames(const std::wstring& directory, const std::wstring& destination);
#if MEMMY_HISTORY_TEST_HOOKS
  static int WriteFixture(const std::wstring& directory);
#endif
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
std::uint64_t QpcTicks();
std::uint64_t QpcFrequency();
}  // namespace memmy::win
