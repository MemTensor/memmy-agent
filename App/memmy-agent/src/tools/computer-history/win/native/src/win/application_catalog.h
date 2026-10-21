#pragma once

#include <string>
#include <vector>

namespace memmy::win {

struct CatalogApplication { std::string executable; std::string name; };

// Display metadata only: shortcuts are loaded without Resolve/launch, and only local,
// existing EXEs are included. No entry grants capture authorization.
std::vector<CatalogApplication> ReadApplicationCatalog(const std::vector<std::wstring>& menus,
                                                     const std::vector<std::wstring>& running);
std::vector<CatalogApplication> ApplicationCatalog();

}  // namespace memmy::win
