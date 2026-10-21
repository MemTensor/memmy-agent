#include "win/task_video.h"
#include "win/system.h"
#include "common/json.h"
#include <wincodec.h>
#include <winrt/base.h>
#include <filesystem>
#include <fstream>
#include <cstdio>
#include <stdexcept>

namespace fs = std::filesystem;
using memmy::Json;
void Require(bool condition) { if (!condition) throw std::runtime_error("task_media_assertion_failed"); }
Json Load(const fs::path& file) {
  std::ifstream input(file); const std::string bytes{std::istreambuf_iterator<char>(input), {}};
  const auto json = memmy::ParseJsonStrict(bytes, 32); Require(json.has_value()); return *json;
}
void Orientation(const fs::path& file) {
  memmy::win::ComScope apartment(COINIT_MULTITHREADED); Require(apartment.Ok());
  winrt::com_ptr<IWICImagingFactory> factory;
  winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
  winrt::com_ptr<IWICBitmapDecoder> decoder;
  winrt::check_hresult(factory->CreateDecoderFromFilename(file.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, decoder.put()));
  winrt::com_ptr<IWICBitmapFrameDecode> frame; winrt::check_hresult(decoder->GetFrame(0, frame.put()));
  UINT width = 0, height = 0; winrt::check_hresult(frame->GetSize(&width, &height)); Require(width == 1920 && height == 1080);
  winrt::com_ptr<IWICFormatConverter> converter; winrt::check_hresult(factory->CreateFormatConverter(converter.put()));
  winrt::check_hresult(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  BYTE top[4]{}, bottom[4]{}; WICRect upper{100, 100, 1, 1}, lower{100, 900, 1, 1};
  winrt::check_hresult(converter->CopyPixels(&upper, 4, 4, top)); winrt::check_hresult(converter->CopyPixels(&lower, 4, 4, bottom));
  Require(top[2] > 160 && top[0] < 30 && bottom[0] > 160 && bottom[2] < 30);
}
int wmain() {
  const fs::path root = fs::temp_directory_path() / (L"memmy-task-video-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directory(root);
    Require(memmy::win::TaskVideo::WriteFixture(root.wstring()) == 0);
    Require(memmy::win::TaskVideo::Finalize(root.wstring()) == 0);
    const auto media = Load(root / L"native-media.json"); Require(media.at("complete").get<bool>() && media.at("parts").size() == 2);
    Require(media.at("durationMs").get<double>() == 2000 && fs::file_size(root / L"recording.mp4") > 0);
    const auto output = root / L"export"; fs::create_directory(output);
    std::ofstream requests(output / L"frame-requests.json");
    requests << R"([{"i":0,"phase":"before","frameId":0,"partId":"part-000001","partFrame":0},{"i":0,"phase":"after","frameId":3,"partId":"part-000002","partFrame":0}])";
    requests.close(); Require(memmy::win::TaskVideo::ExportFrames(root.wstring(), output.wstring()) == 0);
    Orientation(output / L"frames/0000_before.png"); Orientation(output / L"frames/0000_after.png");
    // Display-only repeats cannot be exported as freshly captured action evidence.
    std::ifstream index(root / L"frames.jsonl");
    const std::string indexBytes{std::istreambuf_iterator<char>(index), {}}; index.close();
    const auto newline = indexBytes.find('\n'); Require(newline != std::string::npos);
    auto repeated = memmy::ParseJsonStrict(std::string_view(indexBytes).substr(0, newline), 16).value();
    repeated["repeated"] = true;
    std::ofstream changed(root / L"frames.jsonl", std::ios::trunc);
    changed << memmy::DumpJson(repeated) << '\n' << indexBytes.substr(newline + 1); changed.close();
    const auto repeatOutput = root / L"export-repeated"; fs::create_directory(repeatOutput);
    std::ofstream repeatRequests(repeatOutput / L"frame-requests.json");
    repeatRequests << R"([{"i":0,"phase":"before","frameId":0,"partId":"part-000001","partFrame":0}])"; repeatRequests.close();
    Require(memmy::win::TaskVideo::ExportFrames(root.wstring(), repeatOutput.wstring()) != 0);
    Require(!fs::exists(repeatOutput / L"frames/0000_before.png"));
    std::ofstream restored(root / L"frames.jsonl", std::ios::trunc); restored << indexBytes; restored.close();
    // A corrupted sealed tail is refused while the verified preceding part remains usable.
    std::ofstream broken(root / L"parts/000002.mp4", std::ios::trunc); broken << "broken"; broken.close();
    Require(memmy::win::TaskVideo::Finalize(root.wstring()) == 0);
    const auto partial = Load(root / L"native-media.json"); Require(!partial.at("complete").get<bool>() && partial.at("parts").size() == 1);
    Require(!partial.at("gaps").empty());
    fs::remove_all(root); std::puts("Task video encoding, remux, frame extraction, orientation and sealed-tail recovery passed."); return 0;
  } catch (...) { std::fprintf(stderr, "Task video tests failed; evidence retained in %ls\n", root.c_str()); return 1; }
}
