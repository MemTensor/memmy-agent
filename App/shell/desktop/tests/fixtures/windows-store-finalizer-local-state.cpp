// Compile the real native Store finalizer path checks while replacing its
// application entry point. This fixture calls only the path-validation helpers.
#define wmain memmy_store_helper_entrypoint
#include "MemmyStoreUpdate.cpp"
#undef wmain

int wmain(int argc, wchar_t* argv[])
{
    if (argc != 4)
    {
        return 2;
    }

    const std::filesystem::path profile_alias(argv[1]);
    const std::filesystem::path physical_profile(argv[2]);
    const std::filesystem::path child_alias(argv[3]);

    try
    {
        const std::filesystem::path resolved_root =
            resolve_store_finalizer_profile_authority_root(profile_alias);
        const std::filesystem::path expected_root =
            final_path_for_existing_directory(
                physical_profile,
                L"Unable to resolve the fixture profile target");
        if (normalize_absolute_path(resolved_root) !=
            normalize_absolute_path(expected_root))
        {
            return 3;
        }

        const std::wstring package_family_name = L"Memtensor.Memmy_eyack96k521x2";
        const std::wstring attempt_id = L"00112233-4455-6677-8899-aabbccddeeff";
        const std::filesystem::path expected_attempt =
            expected_root /
            L".memmy" /
            L"store-update" /
            package_family_name /
            attempt_id;
        if (normalize_absolute_path(store_finalizer_attempt_directory(
                resolved_root,
                package_family_name,
                attempt_id)) != normalize_absolute_path(expected_attempt))
        {
            return 6;
        }
    }
    catch (const winrt::hresult_error& error)
    {
        std::cerr << "root-resolution-failed hresult=0x"
            << std::hex << std::uppercase
            << static_cast<uint32_t>(error.code()) << std::endl;
        return 4;
    }

    HRESULT rejection_code = S_OK;
    try
    {
        ensure_plain_store_finalizer_directory(child_alias, false);
    }
    catch (const winrt::hresult_error& error)
    {
        rejection_code = static_cast<HRESULT>(error.code());
    }
    if (rejection_code != E_ACCESSDENIED)
    {
        std::cerr << "child-junction-not-rejected hresult=0x"
            << std::hex << std::uppercase
            << static_cast<uint32_t>(rejection_code) << std::endl;
        return 5;
    }

    if (has_plain_store_finalizer_directory_attributes(
            FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_ENCRYPTED) ||
        !has_plain_store_finalizer_directory_attributes(
            FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_ARCHIVE))
    {
        std::cerr << "encrypted-directory-attributes-not-rejected" << std::endl;
        return 7;
    }

    std::cout << "profile-root-junction-resolved profile-path-bound "
        << "child-junction-rejected encrypted-directory-rejected hresult=0x"
        << std::hex << std::uppercase
        << static_cast<uint32_t>(rejection_code) << std::endl;
    return 0;
}
