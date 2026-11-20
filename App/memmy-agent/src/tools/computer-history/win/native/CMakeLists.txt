cmake_minimum_required(VERSION 3.25)
project(MemmyHistoryRecorder VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "memmy-history-recorder requires MSVC on Windows.")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "memmy-history-recorder is built for x64 only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Static CRT: the shipped executable must not need the VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(MEMMY_HISTORY_BUILD_TESTS "Build unit tests, the controlled fixture and integration harness" ON)

include(cmake/NlohmannJson.cmake)

add_library(memmy_history_options INTERFACE)
target_compile_options(memmy_history_options INTERFACE
  /W4 /WX /permissive- /Zc:__cplusplus /Zc:preprocessor /utf-8 /EHsc /guard:cf /Zi /Brepro)
target_compile_definitions(memmy_history_options INTERFACE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00
  MEMMY_HISTORY_RECORDER_VERSION="${PROJECT_VERSION}")
# Separate PDB next to each binary; the executable embeds only the PDB file name.
target_link_options(memmy_history_options INTERFACE
  /DEBUG /guard:cf /CETCOMPAT /Brepro /PDBALTPATH:%_PDB%
  $<$<NOT:$<CONFIG:Debug>>:/OPT:REF> $<$<NOT:$<CONFIG:Debug>>:/OPT:ICF>)

# Pure logic shared by the recorder, unit tests and the integration harness.
add_library(memmy_history_core STATIC
  src/common/text.cpp
  src/common/browser.cpp
  src/common/json.cpp
  src/common/policy.cpp
  src/common/classify.cpp
  src/common/baseline.cpp
  src/common/trigger_queue.cpp
  src/common/cli.cpp
  src/common/protocol.cpp)
target_include_directories(memmy_history_core PUBLIC src)
target_link_libraries(memmy_history_core PUBLIC memmy_history_options memmy_nlohmann_json winhttp)

set(MEMMY_RECORDER_WIN_SOURCES
  src/win/identity.cpp
  src/win/password.cpp
  src/win/application_catalog.cpp
  src/win/system.cpp
  src/win/hook_thread.cpp
  src/win/control_input.cpp
  src/win/event_output.cpp
  src/win/worker_host.cpp
  src/win/uia_reader.cpp
  src/win/browser_page.cpp
  src/win/commands.cpp
  src/win/task_video.cpp
  src/main.cpp)

# The production executable and the fault-injection test executable are built
# from the same sources. Test hooks exist only when MEMMY_HISTORY_TEST_HOOKS=1.
function(memmy_add_recorder target test_hooks)
  add_executable(${target} ${MEMMY_RECORDER_WIN_SOURCES})
  target_compile_definitions(${target} PRIVATE MEMMY_HISTORY_TEST_HOOKS=${test_hooks})
  target_link_libraries(${target} PRIVATE memmy_history_core ole32 oleaut32 oleacc uiautomationcore bcrypt shell32 version uuid
    d3d11 dxgi dwmapi mf mfplat mfreadwrite mfuuid windowsapp windowscodecs)
endfunction()

memmy_add_recorder(memmy-history-recorder 0)

if(MEMMY_HISTORY_BUILD_TESTS)
  enable_testing()
  add_executable(memmy-task-video-tests tests/unit/task_video_tests.cpp src/win/task_video.cpp src/win/system.cpp src/win/identity.cpp src/win/hook_thread.cpp)
  target_compile_definitions(memmy-task-video-tests PRIVATE MEMMY_HISTORY_TEST_HOOKS=1)
  target_link_libraries(memmy-task-video-tests PRIVATE memmy_history_core ole32 oleaut32 bcrypt shell32 version uuid d3d11 dxgi dwmapi mf mfplat mfreadwrite mfuuid windowsapp windowscodecs)
  add_test(NAME task_video.media_integrity COMMAND memmy-task-video-tests)
  set_tests_properties(task_video.media_integrity PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE)
  memmy_add_recorder(memmy-history-recorder-testhooks 1)

  # Synthetic-document diagnostics only. Never built or staged for production.
  add_executable(memmy-history-capability-probe tests/diagnostics/capability_probe.cpp src/win/identity.cpp)
  target_link_libraries(memmy-history-capability-probe PRIVATE memmy_history_core ole32 oleaut32 uiautomationcore)

  add_executable(memmy-history-unit-tests tests/unit/unit_tests.cpp)
  target_link_libraries(memmy-history-unit-tests PRIVATE memmy_history_core)
  target_compile_definitions(memmy-history-unit-tests PRIVATE
    MEMMY_EXAMPLE_POLICY="${CMAKE_CURRENT_SOURCE_DIR}/examples/policy.example.json")
  add_test(NAME unit COMMAND memmy-history-unit-tests)

  add_executable(memmy-history-win-tests tests/unit/win_tests.cpp
    src/win/control_input.cpp src/win/hook_thread.cpp src/win/event_output.cpp src/win/system.cpp src/win/identity.cpp)
  target_compile_definitions(memmy-history-win-tests PRIVATE MEMMY_HISTORY_TEST_HOOKS=1)
  target_link_libraries(memmy-history-win-tests PRIVATE memmy_history_core bcrypt)
  add_test(NAME win.boundaries COMMAND memmy-history-win-tests)
  set_tests_properties(win.boundaries PROPERTIES TIMEOUT 15 RUN_SERIAL TRUE)

  add_executable(memmy-history-metadata-tests tests/unit/metadata_tests.cpp
    src/win/password.cpp src/win/application_catalog.cpp src/win/identity.cpp)
  target_link_libraries(memmy-history-metadata-tests PRIVATE memmy_history_core ole32 shell32 version uuid)
  add_test(NAME win.metadata COMMAND memmy-history-metadata-tests)
  set_tests_properties(win.metadata PROPERTIES TIMEOUT 15 RUN_SERIAL TRUE)

  add_executable(memmy-history-fixture WIN32 tests/fixture/fixture.cpp)
  target_link_libraries(memmy-history-fixture PRIVATE memmy_history_options memmy_nlohmann_json)
  # A GUI-subsystem fixture still speaks over redirected stdin/stdout.
  target_link_options(memmy-history-fixture PRIVATE /ENTRY:wWinMainCRTStartup)

  add_executable(memmy-history-integration-tests tests/integration/integration_tests.cpp)
  target_link_libraries(memmy-history-integration-tests PRIVATE memmy_history_core ole32 oleaut32 uiautomationcore)
  add_dependencies(memmy-history-integration-tests
    memmy-history-recorder memmy-history-recorder-testhooks memmy-history-fixture)

  set(MEMMY_HISTORY_TEST_ARTIFACTS "${CMAKE_BINARY_DIR}/test-artifacts" CACHE PATH
    "Directory for integration test evidence (policies, JSONL output, stderr)")
  set(MEMMY_INTEGRATION_CASES
    cli_contract policy_strict identity_mismatch browser_unsupported generic_cross_process
    snapshot_content snapshot_not_foreground race_aba race_policy timeout_reap
    commit_races commit_pause commit_control_flood partial_baseline
    observe_lifecycle observe_unauthorized_foreground observe_policy_corrupt observe_policy_race
    observe_ui_hang_recovery observe_eof observe_parent_exit observe_parent_kill
    observe_collector_kill_reaps_worker observe_ctrl_break single_instance rotation_unicode_path
    output_exists output_segment_failure output_flush_failure stdout_broken input_hooks_lifecycle stop_hotkey task_video_lifecycle task_video_static_frames)
  foreach(case IN LISTS MEMMY_INTEGRATION_CASES)
    add_test(NAME integration.${case}
      COMMAND memmy-history-integration-tests
        --case ${case}
        --bin-dir $<TARGET_FILE_DIR:memmy-history-recorder>
        --artifacts "${MEMMY_HISTORY_TEST_ARTIFACTS}")
    # Exit code 77 means the interactive desktop precondition was unavailable.
    set_tests_properties(integration.${case} PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120 RUN_SERIAL TRUE)
  endforeach()
endif()
