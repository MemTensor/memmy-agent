import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperSourcePath = fileURLToPath(new URL(
  "../native/windows-store-update/MemmyStoreUpdate.cpp",
  import.meta.url
));

const sourceBetween = (
  source: string,
  startMarker: string,
  endMarker: string
): string => {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing source marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Missing source marker: ${endMarker}`);
  }
  return source.slice(start, end);
};

const expectSourceOrder = (
  source: string,
  earlierMarker: string,
  laterMarker: string
): void => {
  const earlier = source.indexOf(earlierMarker);
  const later = source.indexOf(laterMarker);
  expect(earlier).toBeGreaterThanOrEqual(0);
  expect(later).toBeGreaterThan(earlier);
};

describe("Windows Store native update helper boundary", () => {
  it("publishes one owned Store shortcut with a stable icon and preserves other applications", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const shortcuts = sourceBetween(source, "std::filesystem::path store_shortcut_local_app_data()", "LegacySourceExecutableIdentity capture_source_executable_identity(");
    expect(shortcuts).toContain("GetCurrentPackageFamilyName");
    expect(shortcuts).toContain("GetCurrentPackagePath");
    expect(shortcuts).toContain('L"LocalState" / L"Memmy" / L"shell"');
    expect(shortcuts).toContain("SetIconLocation(icon.c_str(), 0)");
    expect(shortcuts).toContain("SetIDList(item.value)");
    expect(shortcuts).toContain('index == 0 ? L"Memmy.lnk"');
    expect(shortcuts).not.toContain('L"Memmy (Microsoft Store).lnk"');
    expect(shortcuts).toContain("std::filesystem::exists(target) && !owned(existing)");
    expect(shortcuts).toContain("PackageFamilyNameFromFullName");
    expect(shortcuts).toContain("if (owned(existing)) delete_pinned_store_shortcut(existing)");
    expect(shortcuts).toContain("SHCNE_UPDATEITEM");
  });

  it("rechecks process-exit races without widening the legacy process ownership boundary", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const discovery = sourceBetween(source, "std::vector<ProcessSnapshotEntry> discover_legacy_import_targets(", "bool stop_legacy_for_data_import()");
    expect(discovery).toContain("is_windows_apps_path(entry.image_path)");
    expect(discovery).toContain("process_user_sid(process.get()) != user_sid");
    expect(discovery).toContain("process_package_family(process.get())");
    expect(discovery).toContain("WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0");
    const shutdown = sourceBetween(source, "bool stop_legacy_for_data_import()", "void create_store_shortcut(");
    expect(shutdown).toContain("memmy::stop_legacy_until_clear(");
    expect(shutdown).toContain("terminate_legacy_process_tree(targets, deadline)");
    expect(shutdown).toContain("25'000");
    expect(shutdown).toContain("legacy-stop result=");
  });

  it("exposes StoreContext commands plus authority-bound legacy takeover and cleanup", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const commands = [...source.matchAll(/value == L"([a-z-]+)"/gu)]
      .map((match) => match[1]);

    expect(commands).toEqual([
      "identity",
      "package-family-registration",
      "check",
      "download-silent",
      "download-user",
      "handoff-install",
      "launch-store-update-finalizer",
      "finalize-store-update",
      "startup-status",
      "startup-enable",
      "startup-disable",
      "prepare-legacy-takeover",
      "stop-legacy-for-data-import",
      "create-store-shortcut",
      "discover-legacy-installation",
      "launch-discovered-legacy-cleanup",
      "run-discovered-legacy-cleanup",
      "recover-legacy-cleanup-journal",
      "ensure-legacy-cleanup-broker",
      "legacy-cleanup-broker",
      "stop-legacy-cleanup-broker",
      "authorize-nsis-mutation",
      "finalize-legacy-cleanup",
      "ack-legacy-cleanup",
      "finalize-legacy-cleanup-breakaway-launcher",
      "finalize-legacy-cleanup-unpackaged"
    ]);
    expect(source).toContain("StoreContext::GetDefault()");
    expect(source).toContain("TrySilentDownloadStorePackageUpdatesAsync");
    expect(source).toContain("RequestDownloadStorePackageUpdatesAsync");
    expect(source).toContain("TrySilentDownloadAndInstallStorePackageUpdatesAsync");
    expect(source).toContain("namespace_directory.filename() != options.package_family_name");
    expect(source).toContain("options.package_family_name /");
    expect(source).toContain('store_startup_task_id[] = L"MemmyStartupTask"');
    expect(source).toContain("StartupTask::GetAsync(store_startup_task_id)");
    expect(source).toContain("RequestEnableAsync()");
    expect(source).toContain("startup_task.Disable()");
    expect(source).toContain("StartupTaskState::DisabledByUser");
    expect(source).toContain("StartupTaskState::DisabledByPolicy");
    expect(source).toContain("CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)");
    expect(source).toContain("QueryFullProcessImageNameW");
    expect(source).toContain("WM_CLOSE");
    expect(source).toContain("TerminateProcess");
    expect(source).toContain("stop_legacy_processes(options.legacy_install_directory)");
    expect(source).toContain("Files may already be partially removed, including Memmy.exe");
    expect(source).toContain("--legacy-install-directory");
    expect(source).toContain("--legacy-executable-path");
    expect(source).toContain("--transition-id");
    expect(source).toContain("--attempt-id");
    expect(source).toContain("is_canonical_uuid");
    expect(source).toContain('L"store-transition" / L"diagnostics"');
    expect(source).not.toContain("--diagnostic-log-path");
    expect(source).not.toContain("--log-path must");
    expect(source).toContain("legacy-cleanup-result-v2");
    expect(source).not.toContain("legacy-cleanup-result-v1");
    expect(source).toContain("write_legacy_cleanup_error_to_stderr");
    expect(source).toContain('<< ",\\\"transitionId\\\":\\\""');
    expect(source).toContain('<< ",\\\"attemptId\\\":\\\""');
    expect(source).not.toContain("Unable to append the fixed legacy cleanup diagnostic log");
    expect(source).toContain("Refusing to mutate the real legacy installation from a packaged process");
    expect(source).toContain("Software\\\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4");
    expect(source).toContain("ProcessIdToSessionId");
    expect(source).toContain("GetCurrentPackageFullName");
    expect(source).toContain("struct DeleteTreeResult");
    expect(source).toContain("failed_path");
    expect(source).toContain("KEY_WOW64_32KEY");
    expect(source).toContain("KEY_WOW64_64KEY");
    expect(source).toContain('legacy_app_user_model_id[] = L"cn.memtensor.memmy"');
    expect(source).toContain(
      "delete_registry_value_if_present(run_key, legacy_app_user_model_id);"
    );
    for (const diagnosticEvent of [
      "process-context",
      "authority-registry",
      "legacy-processes-stop",
      "install-directory-delete",
      "install-directory-post-check",
      "uninstall-registry-delete",
      "installer-authority-registry-delete",
      "run-registry-delete",
      "user-path-update",
      "start-menu-shortcut-delete",
      "launcher-directory-delete",
      "apps-folder-shortcut-create"
    ]) {
      expect(source).toContain(diagnosticEvent);
    }
    expect(source).toContain('L"cleanup-journal-v1.bin"');
    expect(source).toContain("LegacyCleanupJournalPhase::Prepared");
    expect(source).toContain("LegacyCleanupJournalPhase::Complete");
    expect(source).toContain("LegacyCleanupJournalPhase::Acknowledged");
    expect(source).toContain("GetNamedPipeClientProcessId");
    expect(source).toContain("GetNamedPipeServerProcessId");
    expect(source).toContain("PIPE_REJECT_REMOTE_CLIENTS");
    expect(source).toContain("FILE_FLAG_FIRST_PIPE_INSTANCE");
    expect(source).toContain("memmy-store-transition-cleanup-broker-v1-");
    expect(source).toContain("MemmyStoreTransitionNsisMutation");
    expect(source).toContain("GetFileInformationByHandle");
    expect(source).toContain("Legacy executable generation changed after broker authority capture");
    expect(source).not.toContain('L"Programs" / L"Memmy"');
    expect(source).not.toMatch(/WindowsApps[\\/][^"\r\n]*_\d+\.\d+\.\d+\.\d+/iu);
  });

  it("queries current-user package registration from the package-family API result", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const registrationQuery = sourceBetween(
      source,
      "std::vector<std::wstring> registered_package_full_names(",
      "void emit_package_family_registration("
    );
    const registrationOutput = sourceBetween(
      source,
      "void emit_package_family_registration(",
      "struct InstalledPackageIdentity"
    );
    const argumentParsing = sourceBetween(
      source,
      "for (int index = 2; index < argc; ++index)",
      "init_apartment(apartment_type::single_threaded);"
    );
    const commandEntry = sourceBetween(
      source,
      "if (command == Command::PackageFamilyRegistration)",
      "init_apartment(apartment_type::single_threaded);"
    );

    expect(registrationQuery.match(/GetPackagesByPackageFamily\(/gu)).toHaveLength(2);
    expect(registrationQuery).toContain("package_full_names.data()");
    expect(registrationQuery).toContain("package_full_name_buffer.data()");
    expect(registrationQuery).toContain("read_count");
    expect(registrationQuery).not.toContain("PackageIdFromFullName");
    expect(registrationQuery).toContain("HRESULT_FROM_WIN32(result)");
    expect(registrationOutput).toContain(
      '\\"type\\":\\"package-family-registration\\"'
    );
    expect(registrationOutput).toContain('\\"packageFamilyName\\":\\"');
    expect(registrationOutput).toContain('\\"registered\\":');
    expect(registrationOutput).toContain('\\"packageFullNames\\":[');
    expect(registrationOutput.match(/write_json_line\(/gu)).toHaveLength(1);
    expect(argumentParsing).toContain(
      "if (command == Command::PackageFamilyRegistration)"
    );
    expect(argumentParsing).toContain(
      'argument != L"--package-family-name"'
    );
    expect(argumentParsing).toContain(
      "Package-family registration accepts only --package-family-name"
    );
    expect(commandEntry).toContain("emit_package_family_registration(");
    expect(commandEntry).toContain(
      "is_valid_package_family_name(registration_package_family_name)"
    );
    expect(commandEntry).toContain("return 0;");
    expect(commandEntry).not.toContain("current_process_has_package_identity");
  });

  it("persists journal v2 source generation and hashes source leases with ASCII-only folding", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const journalSerialization = sourceBetween(
      source,
      "std::vector<unsigned char> serialize_cleanup_journal(",
      "LegacyCleanupJournal deserialize_cleanup_journal("
    );
    const journalDeserialization = sourceBetween(
      source,
      "LegacyCleanupJournal deserialize_cleanup_journal(",
      "void write_cleanup_journal_atomic("
    );
    const sourceGeneration = sourceBetween(
      source,
      "LegacySourceExecutableIdentity capture_source_executable_identity(",
      "LegacyAuthorityCapture capture_legacy_cleanup_authority("
    );
    const sourceLeaseNormalization = sourceBetween(
      source,
      "std::wstring normalize_source_lease_state_path_for_hash(",
      "std::wstring legacy_transition_source_lease_pipe_name()"
    );
    const sourceLeaseName = sourceBetween(
      source,
      "std::wstring legacy_transition_source_lease_pipe_name()",
      "std::wstring legacy_transition_cleanup_active_pipe_name()"
    );

    expect(journalSerialization).toContain(
      "constexpr uint32_t journal_version = 2;"
    );
    expect(journalDeserialization).toContain(
      "constexpr uint32_t journal_version = 2;"
    );
    expect(journalSerialization).toContain(
      "journal.authority.source_executable_identity ? 1U : 0U"
    );
    for (const field of [
      "identity.volume_serial_number",
      "identity.file_index",
      "identity.file_size",
      "identity.last_write_time"
    ]) {
      expect(journalSerialization).toContain(field);
    }
    expect(journalDeserialization).toContain(
      "Cleanup journal has an invalid executable-generation flag"
    );
    expect(journalDeserialization).toContain(
      "journal.authority.source_executable_identity = LegacySourceExecutableIdentity{"
    );
    expect(sourceGeneration).toContain("GetFileInformationByHandle");
    expect(sourceGeneration).toContain("source_executable_identities_match(");
    expect(sourceGeneration).toContain(
      "Legacy executable generation changed after broker authority capture"
    );
    for (const field of [
      "volume_serial_number",
      "file_index",
      "file_size",
      "last_write_time"
    ]) {
      expect(sourceGeneration).toContain(`first.${field} == second.${field}`);
    }

    expect(sourceLeaseNormalization).toContain(
      "character >= L'A' && character <= L'Z'"
    );
    expect(sourceLeaseNormalization).toContain(
      "character + (L'a' - L'A')"
    );
    expect(sourceLeaseNormalization).not.toMatch(
      /\b(?:towlower|tolower|CharLowerBuffW|LCMapStringW|_wcslwr)\b/u
    );
    expect(sourceLeaseName).toContain(
      "utf8(normalize_source_lease_state_path_for_hash(state_path))"
    );
  });

  it("uses an unpackaged, identity-bound broker with durable cleanup and ACK replay", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const broker = sourceBetween(
      source,
      "int run_legacy_cleanup_broker(",
      "void finalize_legacy_cleanup_via_broker("
    );
    const acknowledgementClient = sourceBetween(
      source,
      "void acknowledge_legacy_cleanup_via_broker(",
      "void launch_store_update_finalizer_breakaway("
    );
    const finalizerClient = sourceBetween(
      source,
      "void finalize_legacy_cleanup_via_broker(",
      "bool matching_acknowledged_cleanup_proof_exists("
    );
    const authorization = sourceBetween(
      source,
      "void authorize_nsis_mutation(",
      "LegacyCleanupBrokerResponse cleanup_broker_error_response("
    );
    const sourceGeneration = sourceBetween(
      source,
      "LegacySourceExecutableIdentity capture_source_executable_identity(",
      "LegacyAuthorityCapture capture_legacy_cleanup_authority("
    );
    const durableIdentity = sourceBetween(
      source,
      "bool equivalent_transition_options(",
      "void validate_persisted_authority_shape("
    );

    expect(broker).toContain("Native cleanup broker must start without package identity");
    expect(broker).toContain("validate_cleanup_broker_executable()");
    expect(broker).toContain("validate_cleanup_broker_client(pipe.get(), options, authority_capture)");
    expect(broker).toContain("options.package_family_name != broker_bound_package_family_name");
    expect(broker).toContain("LegacyCleanupBrokerMessage::Cleanup");
    expect(broker).toContain("LegacyCleanupBrokerMessage::Acknowledge");
    expect(broker).toContain("write_cleanup_journal_atomic(prepared_journal)");
    expect(broker).toContain("write_cleanup_journal_atomic(completed_journal)");
    expect(broker).toContain("write_cleanup_journal_atomic(acknowledged_journal)");
    expect(broker).toContain("verify_complete_cleanup_postconditions");
    const cleanupMutationIndex = broker.indexOf(
      "finalize_legacy_cleanup_unpacked(trusted_options, true)"
    );
    const nativePostcheckIndex = broker.indexOf(
      "verify_complete_cleanup_postconditions(",
      cleanupMutationIndex
    );
    const completedJournalIndex = broker.indexOf(
      "write_cleanup_journal_atomic(completed_journal)",
      cleanupMutationIndex
    );
    expect(cleanupMutationIndex).toBeGreaterThan(-1);
    expect(nativePostcheckIndex).toBeGreaterThan(cleanupMutationIndex);
    expect(completedJournalIndex).toBeGreaterThan(nativePostcheckIndex);
    expect(broker).toContain("cleanup-complete-awaiting-store-ack");
    expect(broker).toContain("cleanup-acknowledged-durable");
    expect(broker).toContain("acknowledgedJournalAndNativePostconditionsMatch=true");
    expect(broker).toContain('"broker-response-write"');
    expect(broker).toContain('"durableStatePreserved=true; continueListening="');
    expect(broker).not.toContain("if (SUCCEEDED(response.hresult))");
    expect(acknowledgementClient).toContain("matching_acknowledged_cleanup_proof_exists(options)");
    expect(acknowledgementClient).toContain("durableAcknowledgementMatched=true");
    expect(finalizerClient).toContain("matching_acknowledged_cleanup_proof_exists(options)");
    expect(finalizerClient).toContain("durableAcknowledgementMatched=true; finalizeReplay=true");
    expect(durableIdentity).toContain("attempt_id is intentionally excluded");
    expect(durableIdentity).not.toContain("first.attempt_id");
    expect(durableIdentity).not.toContain("second.attempt_id");
    expect(authorization).toContain("require_parent_held_transition_mutation_mutex()");
    expect(authorization).toContain("exclusive_pipe_name_is_owned(legacy_transition_cleanup_active_pipe_name())");
    expect(authorization).toContain("any_allowed_memmy_package_is_registered()");
    expect(authorization).toContain("validate_persisted_authority_shape");
    expect(sourceGeneration).toContain("GetFileInformationByHandle");
    expect(sourceGeneration).toContain("dwVolumeSerialNumber");
    expect(sourceGeneration).toContain("nFileIndexHigh");
    expect(sourceGeneration).toContain("nFileIndexLow");
  });

  it("revalidates the Store cleanup authority after acquiring the mutation mutex", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const authorization = sourceBetween(
      source,
      "void require_post_mutex_cleanup_authorization(",
      "scoped_handle create_transition_mutation_mutex()"
    );
    const broker = sourceBetween(
      source,
      "int run_legacy_cleanup_broker(",
      "void finalize_legacy_cleanup_via_broker("
    );

    expect(authorization).toContain("exclusive_pipe_name_is_owned(legacy_transition_source_lease_pipe_name())");
    expect(authorization).toContain("registered_package_full_names(options.package_family_name)");
    expect(authorization).toContain("HRESULT_FROM_WIN32(ERROR_RETRY)");
    expect(broker.match(/require_post_mutex_cleanup_authorization\(trusted_options\)/gu)).toHaveLength(2);

    const replayMutex = broker.indexOf("transition_mutation_ownership.acquire(transition_mutation_mutex.get())");
    const replayAuthorization = broker.indexOf(
      "require_post_mutex_cleanup_authorization(trusted_options)",
      replayMutex
    );
    const replayPostcheck = broker.indexOf(
      "verify_complete_cleanup_postconditions(",
      replayAuthorization
    );
    expect(replayAuthorization).toBeGreaterThan(replayMutex);
    expect(replayPostcheck).toBeGreaterThan(replayAuthorization);

    const cleanupMutex = broker.indexOf(
      "transition_mutation_ownership.acquire(transition_mutation_mutex.get())",
      replayMutex + 1
    );
    const cleanupAuthorization = broker.indexOf(
      "require_post_mutex_cleanup_authorization(trusted_options)",
      cleanupMutex
    );
    const authorityMutationAttestation = broker.indexOf(
      '"broker-authority-mutation-attestation"',
      cleanupAuthorization
    );
    expect(cleanupAuthorization).toBeGreaterThan(cleanupMutex);
    expect(authorityMutationAttestation).toBeGreaterThan(cleanupAuthorization);
  });

  it("retries an attested partial directory cleanup after the legacy executable is already gone", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const finalize = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "DWORD current_process_session_id()"
    );
    const processStop = finalize.indexOf("stop_legacy_processes(options.legacy_install_directory)");
    const destructiveDelete = finalize.indexOf("remove_legacy_install_directory(options)");

    expect(finalize).toContain("if (authority_was_attested)");
    expect(finalize).toContain("else\n            {\n                prepare_legacy_takeover(options);");
    expect(processStop).toBeGreaterThan(finalize.indexOf("if (authority_was_attested)"));
    expect(destructiveDelete).toBeGreaterThan(processStop);
  });

  it("retires cleanup journals only after both allowed Store PFNs are absent", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const packageRegistration = sourceBetween(
      source,
      "bool any_allowed_memmy_package_is_registered()",
      "void validate_offline_cleanup_broker_stop()"
    );
    const nativeInstallRetirement = sourceBetween(
      source,
      "void retire_orphaned_cleanup_journal_for_native_install()",
      "void send_broker_frame("
    );
    const orphanValidation = sourceBetween(
      source,
      "void validate_orphaned_cleanup_journal_for_native_install(",
      "void retire_orphaned_cleanup_journal_for_native_install()"
    );
    const offlineStop = sourceBetween(
      source,
      "void validate_offline_cleanup_broker_stop()",
      "void throw_broker_response_failure("
    );
    const onlineStop = sourceBetween(
      source,
      "else if (message == LegacyCleanupBrokerMessage::Stop)",
      "else if (message == LegacyCleanupBrokerMessage::Acknowledge)"
    );

    expect(packageRegistration).toContain(
      "registered_package_full_names(allowed_memmy_package_family)"
    );
    expect(packageRegistration).toContain(
      "registered_package_full_names(allowed_memmy_agent_package_family)"
    );
    expect(packageRegistration).toContain(".empty() ||");

    expect(orphanValidation).toContain(
      "Refusing to retire a cleanup journal while a Memmy Store package remains registered"
    );
    expectSourceOrder(
      orphanValidation,
      "registered_package_full_names(allowed_memmy_agent_package_family)",
      "if (journal.phase == LegacyCleanupJournalPhase::Acknowledged)"
    );
    expectSourceOrder(
      nativeInstallRetirement,
      "validate_orphaned_cleanup_journal_for_native_install(*journal)",
      "delete_cleanup_journal_file("
    );
    expect(offlineStop).toContain(
      "Refusing offline cleanup broker shutdown while a Memmy Store package is registered"
    );
    expectSourceOrder(
      offlineStop,
      "if (any_allowed_memmy_package_is_registered())",
      "delete_cleanup_journal_file("
    );
    expect(onlineStop).toContain(
      "Refusing to stop a cleanup broker while a Memmy Store package is registered"
    );
    expectSourceOrder(
      onlineStop,
      "if (any_allowed_memmy_package_is_registered())",
      "delete_cleanup_journal_file("
    );
    expect(source.match(/delete_cleanup_journal_file\(/gu)).toHaveLength(5);
  });

  it("recovers only a fixed orphan journal under exclusive cleanup and mutation locks without starting a broker", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const recovery = sourceBetween(source,
      "bool recover_orphaned_cleanup_journal()", "void require_parent_held_transition_mutation_mutex()");
    const validation = sourceBetween(source,
      "void validate_orphaned_cleanup_journal_for_native_install(",
      "void retire_orphaned_cleanup_journal_for_native_install()");
    const entry = sourceBetween(source,
      "if (command == Command::RecoverLegacyCleanupJournal)",
      "if (command == Command::EnsureLegacyCleanupBroker ||");
    const routing = sourceBetween(source,
      "bool is_legacy_transition_command(Command command)",
      "bool is_legacy_cleanup_diagnostic_command(Command command)");
    const ownership = sourceBetween(source, "class scoped_mutex_ownership", "struct ProcessSnapshotEntry");

    expect(entry).toContain("if (argc != 2)");
    expectSourceOrder(entry, "Orphan cleanup journal recovery accepts no options", "recover_orphaned_cleanup_journal()");
    expect(entry).toContain('recovered ? "recovered" : "no-journal"');
    expect(routing).toContain("Command::RecoverLegacyCleanupJournal");
    expectSourceOrder(recovery, "current_process_has_package_identity()", "scoped_handle cleanup_guard(");
    expect(recovery).toContain("legacy_transition_cleanup_active_pipe_name()");
    expect(recovery).toContain("PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE");
    expectSourceOrder(recovery, "if (!cleanup_guard)", "create_transition_mutation_mutex()");
    expectSourceOrder(recovery, "mutation_ownership.acquire(mutation_mutex.get())", "read_cleanup_journal()");
    expectSourceOrder(recovery, "read_cleanup_journal()", "validate_orphaned_cleanup_journal_for_native_install(*journal)");
    expectSourceOrder(recovery, "validate_orphaned_cleanup_journal_for_native_install(*journal)", "delete_cleanup_journal_file(");
    expect(recovery).toContain("return false;");
    expect(recovery).toContain("return true;");
    expect(ownership).toContain("WaitForSingleObject(handle_, 15000)");
    expect(ownership).toContain("~scoped_mutex_ownership() noexcept");
    expect(validation).toContain("validate_persisted_authority_shape(journal.authority, journal.options)");
    expect(validation).toContain("require_allowed_memmy_package_identity(journal.options)");
    expect(validation).toContain("registered_package_full_names(allowed_memmy_package_family)");
    expect(validation).toContain("registered_package_full_names(allowed_memmy_agent_package_family)");
    expect(validation).toContain("capture_legacy_cleanup_authority()");
    expect(validation).toContain("FILE_ATTRIBUTE_REPARSE_POINT");
    for (const forbidden of [
      "ensure_legacy_cleanup_broker(", "launch_cleanup_broker_process(",
      "register_cleanup_broker_run_value(", "try_stop_cleanup_broker(",
      "finalize_legacy_cleanup_unpacked(", "remove_legacy_install_directory(",
      "legacy_transition_source_lease_pipe_name()", "exclusive_pipe_name_is_owned("
    ]) {
      expect(recovery + validation + entry).not.toContain(forbidden);
    }
  });

  it("rejects Store handoff and UI options for every legacy CLI and keeps authorize argument-free", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const legacyClassification = sourceBetween(
      source,
      "bool is_legacy_transition_command(Command command)",
      "bool is_legacy_cleanup_diagnostic_command(Command command)"
    );
    const argumentParsing = sourceBetween(
      source,
      "bool store_only_option_was_provided = false;",
      "init_apartment(apartment_type::single_threaded);"
    );
    const handoffOptions = sourceBetween(
      source,
      "bool has_handoff_options(const StoreInstallHandoffOptions& options)",
      "int run_message_loop()"
    );
    const authorizationEntry = sourceBetween(
      source,
      "if (command == Command::AuthorizeNsisMutation)",
      "if (command == Command::PrepareLegacyTakeover)"
    );
    const classifiedCommands = [...legacyClassification.matchAll(
      /command == Command::([A-Za-z]+)/gu
    )].map((match) => match[1]);

    expect(classifiedCommands).toEqual([
      "PrepareLegacyTakeover",
      "StopLegacyForDataImport",
      "CreateStoreShortcut",
      "DiscoverLegacyInstallation",
      "LaunchDiscoveredLegacyCleanup",
      "RunDiscoveredLegacyCleanup",
      "RecoverLegacyCleanupJournal",
      "EnsureLegacyCleanupBroker",
      "LegacyCleanupBroker",
      "StopLegacyCleanupBroker",
      "AuthorizeNsisMutation",
      "FinalizeLegacyCleanup",
      "AckLegacyCleanup",
      "FinalizeLegacyCleanupBreakawayLauncher",
      "FinalizeLegacyCleanupUnpackaged"
    ]);
    expect(argumentParsing).toContain(
      "if (is_legacy_transition_command(command) &&"
    );
    expect(argumentParsing).toContain(
      "store_only_option_was_provided || owner != nullptr || has_handoff_options(options)"
    );
    expect(argumentParsing).toContain(
      "Legacy transition commands do not accept Store handoff or UI options"
    );
    for (const field of [
      "external_helper_path",
      "state_path",
      "result_path",
      "log_path",
      "old_process_id",
      "baseline_package_version",
      "baseline_package_full_name",
      "created_at",
      "aumid",
      "package_family_name",
      "mode"
    ]) {
      expect(handoffOptions).toContain(`options.${field}`);
    }
    for (const option of [
      "--hwnd",
      "--state-path",
      "--result-path",
      "--log-path",
      "--old-pid",
      "--baseline-package-version",
      "--baseline-package-full-name",
      "--created-at",
      "--mode"
    ]) {
      const optionBranch = sourceBetween(
        argumentParsing,
        `if (argument == L"${option}")`,
        "continue;"
      );
      expect(optionBranch).toContain("store_only_option_was_provided = true;");
    }

    expect(source).toContain("void authorize_nsis_mutation()");
    for (const field of [
      "external_helper_path",
      "legacy_install_directory",
      "legacy_executable_path",
      "shortcut_path",
      "aumid",
      "package_family_name",
      "transition_id",
      "attempt_id"
    ]) {
      expect(authorizationEntry).toContain(`legacy_options.${field}.empty()`);
    }
    expect(authorizationEntry).toContain(
      "NSIS mutation authorization accepts no options"
    );
    expectSourceOrder(
      authorizationEntry,
      "NSIS mutation authorization accepts no options",
      "authorize_nsis_mutation();"
    );
  });

  it("keeps deprecated breakaway cleanup entry points fail closed", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const breakawayEntry = sourceBetween(
      source,
      "if (command == Command::FinalizeLegacyCleanupBreakawayLauncher)",
      "if (command == Command::FinalizeLegacyCleanupUnpackaged)"
    );
    const unpackagedEntry = sourceBetween(
      source,
      "if (command == Command::FinalizeLegacyCleanupUnpackaged)",
      "if (command == Command::HandoffInstall)"
    );

    for (const entry of [breakawayEntry, unpackagedEntry]) {
      expect(entry).toContain("ERROR_NOT_SUPPORTED");
      expect(entry).not.toContain("finalize_legacy_cleanup_unpacked(");
      expect(entry).not.toContain("run_legacy_cleanup_process(");
    }
    expect(breakawayEntry).toContain("use the pre-established native broker");
    expect(unpackagedEntry).toContain("use the pre-established native broker");
  });

  it("fails closed when the fixed diagnostic result channel is unavailable", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const initialization = sourceBetween(
      source,
      "void initialize_legacy_cleanup_diagnostics(",
      "std::filesystem::path legacy_cleanup_process_result_path("
    );
    const childResultHandling = sourceBetween(
      source,
      "void run_legacy_cleanup_process(",
      "void finalize_legacy_cleanup_unpacked("
    );

    expect(initialization).not.toContain("noexcept");
    expect(initialization).not.toContain("catch (...)");
    expect(initialization).toContain("write_text_file_atomic(");
    expect(initialization).toContain('L".result"');
    expect(initialization).toContain("legacy-cleanup-result-v2");
    expect(initialization).toContain("ProcessIdToSessionId");
    expect(initialization).toContain("APPMODEL_ERROR_NO_PACKAGE");
    expect(initialization).toContain(
      "Unable to initialize the fixed legacy cleanup diagnostic log"
    );
    expect(childResultHandling).toContain(
      "const HRESULT child_exit_hresult = static_cast<HRESULT>(exit_code)"
    );
    expect(childResultHandling).toContain("child-result-channel");
  });

  it("deletes and verifies both registry views using authority-bound values", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const authorityValidation = sourceBetween(
      source,
      "bool validate_legacy_install_authority(",
      "ULONGLONG query_process_creation_time("
    );
    const registryDelete = sourceBetween(
      source,
      "void delete_registry_tree_if_present(",
      "void delete_registry_value_if_present("
    );
    const destructiveCleanup = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "void launch_store_update_finalizer_breakaway("
    );

    expect(authorityValidation).toContain("recorded_install_directory_32");
    expect(authorityValidation).toContain("recorded_install_directory_64");
    expect(authorityValidation).toContain("KEY_WOW64_32KEY");
    expect(authorityValidation).toContain("KEY_WOW64_64KEY");
    expect(authorityValidation).toContain("authority_matches");
    expect(registryDelete).toContain(
      "DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | view_access"
    );
    expect(registryDelete).toContain("RegDeleteTreeW(key, nullptr)");
    expect(registryDelete).toContain("RegDeleteKeyExW(");
    expect(registryDelete).not.toContain("view=process-default");
    expect(destructiveCleanup.match(/delete_registry_tree_if_present\(/gu)).toHaveLength(4);
    expect(destructiveCleanup.match(/registry_tree_exists\(/gu)).toHaveLength(4);
    expect(destructiveCleanup).toContain("RegOpenKeyExW(post-check)");
  });

  it("treats the Shell-reported shortcut path as advisory and verifies the exact desktop file", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const shortcutCreation = sourceBetween(
      source,
      "void create_apps_folder_shortcut(",
      "std::string utf8("
    );
    const destructiveCleanup = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "void launch_store_update_finalizer_breakaway("
    );

    expect(shortcutCreation).not.toContain("error-ignored");
    expect(shortcutCreation).not.toContain("path-present-unverified");
    expect(shortcutCreation).toContain(
      "Unable to remove the existing Memmy desktop shortcut"
    );
    expect(shortcutCreation).not.toContain(
      "Windows did not report the created Memmy desktop shortcut path"
    );
    expect(shortcutCreation).not.toMatch(
      /set_legacy_cleanup_failure_context\(\s*"SHGetNameFromIDList"/u
    );
    expect(shortcutCreation).not.toMatch(
      /if\s*\(\s*FAILED\(created_path_result\)/u
    );
    expect(shortcutCreation).not.toContain(
      "check_hresult(created_path_result)"
    );
    expect(shortcutCreation).toContain("path-resolution-unavailable");
    expect(shortcutCreation).toContain(
      "!created_shortcut_path.empty() &&"
    );
    expect(shortcutCreation).toContain(
      "normalize_absolute_path(created_shortcut_path) !="
    );
    expect(shortcutCreation).toContain(
      "Windows created the Memmy desktop shortcut at an unexpected path"
    );
    expect(shortcutCreation).toContain(
      "Windows did not create the expected Memmy desktop shortcut"
    );
    expect(shortcutCreation).toContain("FILE_ATTRIBUTE_DIRECTORY");
    expect(shortcutCreation).toContain("FILE_ATTRIBUTE_REPARSE_POINT");
    expect(shortcutCreation).toContain(
      "The created Memmy desktop shortcut is not a regular file"
    );
    expect(shortcutCreation.indexOf("check_hresult(link_result);")).toBeLessThan(
      shortcutCreation.indexOf("std::filesystem::exists(")
    );
    expect(destructiveCleanup).toContain("FOLDERID_Programs");
    expect(destructiveCleanup).toContain(
      "Unable to delete the legacy Memmy Start Menu shortcut"
    );
    expect(destructiveCleanup).toContain(
      "The legacy Memmy launch proxy directory is still present after cleanup"
    );
    expect(destructiveCleanup.match(/GetFileAttributesW\(post-check\)/gu).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("keeps Store transition control files outside any removable legacy install tree", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const diagnosticPathResolution = sourceBetween(
      source,
      "std::filesystem::path resolve_legacy_cleanup_diagnostics_directory(",
      "void initialize_legacy_cleanup_diagnostics("
    );
    const authorityValidation = sourceBetween(
      source,
      "bool validate_legacy_install_authority(",
      "ULONGLONG query_process_creation_time("
    );
    const treeDeletion = sourceBetween(
      source,
      "DeleteTreeResult delete_directory_tree_once(",
      "void remove_legacy_install_directory("
    );

    expect(diagnosticPathResolution).toContain(
      "paths_overlap(options.legacy_install_directory, memmy_directory)"
    );
    expect(authorityValidation).toContain(
      "paths_overlap(legacy_install_directory, store_control_directory)"
    );
    expect(treeDeletion).toContain("RemoveDirectoryW(empty-directory)");
  });
});
