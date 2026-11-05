#include "win/worker_host.h"

#include "common/cli.h"
#include "win/system.h"

#include <atomic>
#include <memory>
#include <thread>
#include <vector>

namespace memmy::win {
namespace {

struct Pipes {
  UniqueHandle childIn, parentIn;    // child reads request
  UniqueHandle parentOut, childOut;  // child writes response
  UniqueHandle parentErr, childErr;  // child diagnostics
};

bool MakePipe(UniqueHandle& read, UniqueHandle& write, bool childReads) {
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE r = nullptr;
  HANDLE w = nullptr;
  if (!CreatePipe(&r, &w, &sa, 64 * 1024)) return false;
  read = Own(r);
  write = Own(w);
  // Only the child's end stays inheritable, and the handle list restricts it further.
  return SetHandleInformation(childReads ? write.get() : read.get(), HANDLE_FLAG_INHERIT, 0) != FALSE;
}

struct IoState {
  std::string out;
  std::size_t outTotal = 0;
  std::size_t errTotal = 0;
  std::atomic<bool> outOverflow{false};
};

void Drain(HANDLE pipe, std::string* keep, std::size_t cap, std::size_t& total, std::atomic<bool>* overflow) {
  char buffer[16 * 1024];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) || read == 0) return;
    total += read;
    if (keep != nullptr) {
      if (keep->size() + read <= cap) {
        keep->append(buffer, read);
      } else if (overflow != nullptr) {
        overflow->store(true);  // keep draining so the child never blocks on a full pipe
      }
    }
  }
}

bool JoinBounded(std::thread& thread, DWORD timeoutMs) {
  if (!thread.joinable()) return true;
  const HANDLE native = static_cast<HANDLE>(thread.native_handle());
  if (WaitForSingleObject(native, timeoutMs) != WAIT_OBJECT_0) {
    CancelSynchronousIo(native);
    if (WaitForSingleObject(native, timeoutMs) != WAIT_OBJECT_0) {
      thread.detach();
      return false;
    }
  }
  thread.join();
  return true;
}

}  // namespace

bool WorkerHost::Init(std::string& error) {
  self_ = SelfExecutablePath();
  if (self_.empty()) {
    error = "self_path_unavailable";
    return false;
  }
  job_ = Own(CreateJobObjectW(nullptr, nullptr));
  if (!job_) {
    error = "job_create_failed";
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
                                            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.ProcessMemoryLimit = 1024ull * 1024 * 1024;
  if (!SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    error = "job_configure_failed";
    job_.reset();
    return false;
  }
  return true;
}

WorkerOutcome WorkerHost::Run(const std::string& request, DWORD timeoutMs, const HANDLE* cancelHandles,
                              DWORD cancelCount) {
  WorkerOutcome outcome;
  const double started = MonotonicMs();
  const auto finish = [&](WorkerOutcome::Kind kind) {
    outcome.kind = kind;
    outcome.elapsedMs = MonotonicMs() - started;
    return outcome;
  };
  if (!job_) return finish(WorkerOutcome::Kind::JobFailed);

  Pipes pipes;
  if (!MakePipe(pipes.childIn, pipes.parentIn, true) || !MakePipe(pipes.parentOut, pipes.childOut, false) ||
      !MakePipe(pipes.parentErr, pipes.childErr, false)) {
    return finish(WorkerOutcome::Kind::LaunchFailed);
  }

  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize);
  std::vector<unsigned char> attributeBuffer(attributeSize);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &attributeSize)) {
    return finish(WorkerOutcome::Kind::LaunchFailed);
  }
  HANDLE inherited[3] = {pipes.childIn.get(), pipes.childOut.get(), pipes.childErr.get()};
  // The worker joins the kill-on-close job atomically at creation. Assigning it afterwards
  // would leave a window in which a collector killed between CreateProcess and the assignment
  // strands a suspended worker outside the job.
  HANDLE jobs[1] = {job_.get()};
  const bool listed = UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                                sizeof(inherited), nullptr, nullptr) != FALSE &&
                      UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs),
                                                nullptr, nullptr) != FALSE;
  if (!listed) {
    DeleteProcThreadAttributeList(attributes);
    return finish(WorkerOutcome::Kind::JobFailed);
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = pipes.childIn.get();
  startup.StartupInfo.hStdOutput = pipes.childOut.get();
  startup.StartupInfo.hStdError = pipes.childErr.get();
  startup.lpAttributeList = attributes;
  std::wstring commandLine = cli::QuoteArgument(self_) + L" __worker";
  PROCESS_INFORMATION info{};
  const BOOL created =
      CreateProcessW(self_.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                     CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                     nullptr, nullptr, &startup.StartupInfo, &info);
  const DWORD createError = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attributes);
  pipes.childIn.reset();
  pipes.childOut.reset();
  pipes.childErr.reset();
  if (!created) {
    // Job-list rejection (e.g. a job that cannot be nested here) is a job failure: fail closed.
    return finish(createError == ERROR_ACCESS_DENIED || createError == ERROR_NOT_SUPPORTED
                      ? WorkerOutcome::Kind::JobFailed
                      : WorkerOutcome::Kind::LaunchFailed);
  }
  UniqueHandle process = Own(info.hProcess);
  UniqueHandle mainThread = Own(info.hThread);
  outcome.pid = info.dwProcessId;

  // Fail closed: a worker that is not verifiably inside the job never runs.
  BOOL inJob = FALSE;
  if (!IsProcessInJob(process.get(), job_.get(), &inJob) || !inJob) {
    TerminateProcess(process.get(), 0xDEAD);
    outcome.reaped = WaitForSingleObject(process.get(), 2000) == WAIT_OBJECT_0;
    return finish(WorkerOutcome::Kind::JobFailed);
  }

  auto io = std::make_shared<IoState>();
  auto requestCopy = std::make_shared<std::string>(request);
  auto inPipe = std::make_shared<UniqueHandle>(std::move(pipes.parentIn));
  auto outPipe = std::make_shared<UniqueHandle>(std::move(pipes.parentOut));
  auto errPipe = std::make_shared<UniqueHandle>(std::move(pipes.parentErr));
  std::thread writer([requestCopy, inPipe] {
    std::size_t total = 0;
    while (total < requestCopy->size()) {
      DWORD written = 0;
      if (!WriteFile(inPipe->get(), requestCopy->data() + total, static_cast<DWORD>(requestCopy->size() - total),
                     &written, nullptr) ||
          written == 0) {
        break;
      }
      total += written;
    }
    inPipe->reset();  // EOF for the worker
  });
  std::thread outReader([io, outPipe] { Drain(outPipe->get(), &io->out, kMaxStdout, io->outTotal, &io->outOverflow); });
  std::thread errReader([io, errPipe] { Drain(errPipe->get(), nullptr, kMaxStderr, io->errTotal, nullptr); });

  ResumeThread(mainThread.get());

  std::vector<HANDLE> waits = {process.get()};
  for (DWORD i = 0; i < cancelCount; ++i) waits.push_back(cancelHandles[i]);
  const DWORD wait = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, timeoutMs);
  WorkerOutcome::Kind kind = WorkerOutcome::Kind::Completed;
  if (wait != WAIT_OBJECT_0) {
    kind = wait == WAIT_TIMEOUT ? WorkerOutcome::Kind::TimedOut
           : (wait > WAIT_OBJECT_0 && wait < WAIT_OBJECT_0 + waits.size()) ? WorkerOutcome::Kind::Cancelled
                                                                             : WorkerOutcome::Kind::Failed;
    TerminateProcess(process.get(), 0xDEAD);
    outcome.reaped = WaitForSingleObject(process.get(), 2000) == WAIT_OBJECT_0;
  }
  GetExitCodeProcess(process.get(), &outcome.exitCode);

  const bool joined = JoinBounded(writer, 1000) & JoinBounded(outReader, 1000) & JoinBounded(errReader, 1000);
  // A detached reader may still own the buffers; never read them in that case.
  if (!joined) return finish(kind == WorkerOutcome::Kind::Completed ? WorkerOutcome::Kind::Failed : kind);
  outcome.stderrBytes = io->errTotal;
  if (kind == WorkerOutcome::Kind::Completed) {
    if (io->outOverflow.load()) return finish(WorkerOutcome::Kind::OutputTooLarge);
    if (outcome.exitCode != 0) return finish(WorkerOutcome::Kind::Failed);
    outcome.output = std::move(io->out);
  }
  return finish(kind);
}

}  // namespace memmy::win
