#pragma once

#include "common/policy.h"
#include "common/protocol.h"

namespace memmy::win {

// Performs one bounded UIA read for an already-authorized request. Must run on a thread with
// no windows in a worker process; COM objects never leave this function.
protocol::WorkerResponse ReadSnapshot(const protocol::WorkerRequest& request, const policy::Policy& policy);

// "__worker" entry point: one JSON request on stdin, one JSON response line on stdout.
int WorkerMain();

}  // namespace memmy::win
