#include "win/task_video.h"
#include "common/json.h"
#include "common/policy.h"
#include "common/protocol.h"
#include "common/text.h"
#include "common/idle_video_timeline.h"
#include "win/hook_thread.h"
#include "win/identity.h"
#include "win/system.h"

#include <d3d11.h>
#include <dxgi.h>
#include <dwmapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <codecapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace memmy::win {
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
namespace {
constexpr UINT kWidth = 1920, kHeight = 1080, kFps = 15;
constexpr LONGLONG kTicksPerSecond = 10000000;
// Media Foundation encodes stream selectors as signed enum sentinels; its APIs take DWORD.
constexpr DWORD kAllReaderStreams = static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS);
constexpr DWORD kFirstReaderVideoStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
using winrt::check_hresult;
using winrt::com_ptr;

bool Reparse(const std::filesystem::path& file) {
  const DWORD attributes = GetFileAttributesW(file.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}
void CheckDirectory(const std::filesystem::path& directory) {
  if (!std::filesystem::is_directory(directory) || Reparse(directory)) throw std::runtime_error("invalid_directory");
}
UniqueHandle PackageLease(const std::filesystem::path& directory, bool wait) {
  const auto file = directory / L"capture.lock";
  if (Reparse(file)) throw std::runtime_error("invalid_lock");
  for (unsigned attempt = 0; attempt < (wait ? 50u : 1u); ++attempt) {
    auto lock = Own(CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
    if (lock) return lock;
    if (GetLastError() != ERROR_SHARING_VIOLATION || !wait) break;
    Sleep(100);
  }
  throw std::runtime_error("recording_package_busy");
}
std::string Read(const std::filesystem::path& file, std::uintmax_t limit = 8 * 1024 * 1024) {
  if (Reparse(file) || !std::filesystem::is_regular_file(file) || std::filesystem::file_size(file) > limit) throw std::runtime_error("invalid_file");
  std::ifstream stream(file, std::ios::binary);
  if (!stream) throw std::runtime_error("read_failed");
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void WriteAll(HANDLE file, std::string_view bytes) {
  while (!bytes.empty()) {
    DWORD written = 0;
    if (!WriteFile(file, bytes.data(), static_cast<DWORD>(std::min<std::size_t>(bytes.size(), MAXDWORD)), &written, nullptr) || written == 0) throw std::runtime_error("write_failed");
    bytes.remove_prefix(written);
  }
}
void AtomicJson(const std::filesystem::path& file, const Json& value) {
  const auto temporary = std::filesystem::path(file.wstring() + L".tmp");
  if (Reparse(file) || Reparse(temporary)) throw std::runtime_error("invalid_file");
  auto handle = Own(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!handle) throw std::runtime_error("write_failed");
  WriteAll(handle.get(), DumpJson(value));
  if (!FlushFileBuffers(handle.get())) throw std::runtime_error("flush_failed");
  handle.reset();
  if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("rename_failed");
}
Json LoadJson(const std::filesystem::path& file) {
  const auto parsed = ParseJsonStrict(Read(file), 24);
  if (!parsed) throw std::runtime_error("invalid_json");
  return *parsed;
}
std::wstring PartName(unsigned index, const wchar_t* extension) {
  wchar_t buffer[32]{};
  swprintf_s(buffer, L"%06u.%ls", index, extension);
  return buffer;
}
double Elapsed(std::uint64_t tick, std::uint64_t origin, std::uint64_t frequency) {
  return static_cast<double>(tick - origin) * 1000.0 / static_cast<double>(frequency);
}
struct MfScope {
  MfScope() { check_hresult(MFStartup(MF_VERSION, MFSTARTUP_FULL)); }
  ~MfScope() { MFShutdown(); }
};
struct RuntimeScope {
  RuntimeScope() { winrt::init_apartment(winrt::apartment_type::multi_threaded); }
  ~RuntimeScope() { winrt::uninit_apartment(); }
};
com_ptr<IMFMediaType> VideoType(const GUID& subtype) {
  com_ptr<IMFMediaType> type;
  check_hresult(MFCreateMediaType(type.put()));
  check_hresult(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
  check_hresult(type->SetGUID(MF_MT_SUBTYPE, subtype));
  check_hresult(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
  check_hresult(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, kWidth, kHeight));
  check_hresult(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, kFps, 1));
  check_hresult(MFSetAttributeRatio(type.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
  return type;
}
class Encoder {
 public:
  void Open(const std::filesystem::path& file) {
    if (std::filesystem::exists(file) || Reparse(file)) throw std::runtime_error("output_exists");
    com_ptr<IMFAttributes> attributes;
    check_hresult(MFCreateAttributes(attributes.put(), 3));
    check_hresult(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE));
    check_hresult(attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE));
    check_hresult(MFCreateSinkWriterFromURL(file.c_str(), nullptr, attributes.get(), writer_.put()));
    auto output = VideoType(MFVideoFormat_H264);
    check_hresult(output->SetUINT32(MF_MT_AVG_BITRATE, 6000000));
    check_hresult(output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base));
    check_hresult(writer_->AddStream(output.get(), &stream_));
    auto input = VideoType(MFVideoFormat_RGB32);
    check_hresult(writer_->SetInputMediaType(stream_, input.get(), nullptr));
    check_hresult(writer_->BeginWriting());
  }
  void Push(const std::vector<std::uint8_t>& pixels, LONGLONG time) {
    Flush(time);
    com_ptr<IMFMediaBuffer> buffer;
    check_hresult(MFCreateMemoryBuffer(static_cast<DWORD>(pixels.size()), buffer.put()));
    BYTE* data = nullptr;
    check_hresult(buffer->Lock(&data, nullptr, nullptr));
    std::copy(pixels.begin(), pixels.end(), data);
    check_hresult(buffer->Unlock());
    check_hresult(buffer->SetCurrentLength(static_cast<DWORD>(pixels.size())));
    check_hresult(MFCreateSample(pending_.put()));
    check_hresult(pending_->AddBuffer(buffer.get()));
    check_hresult(pending_->SetSampleTime(time));
    pendingTime_ = time;
  }
  void Close(LONGLONG end) {
    Flush(end);
    if (writer_) check_hresult(writer_->Finalize());
    writer_ = nullptr;
  }
 private:
  void Flush(LONGLONG next) {
    if (!pending_) return;
    check_hresult(pending_->SetSampleDuration(std::max<LONGLONG>(1, next - pendingTime_)));
    check_hresult(writer_->WriteSample(stream_, pending_.get()));
    pending_ = nullptr;
  }
  com_ptr<IMFSinkWriter> writer_;
  com_ptr<IMFSample> pending_;
  DWORD stream_ = 0;
  LONGLONG pendingTime_ = 0;
};
enum class CaptureResult { Frame, Empty, Unavailable };
class WindowCapture {
 public:
  void Init() {
    if (!GraphicsCaptureSession::IsSupported()) throw std::runtime_error("wgc_unavailable");
    check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, device_.put(), nullptr, context_.put()));
    auto dxgi = device_.as<IDXGIDevice>();
    com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
    runtime_ = inspectable.as<IDirect3DDevice>();
  }
  void Close() {
    if (session_) session_.Close();
    if (pool_) pool_.Close();
    session_ = nullptr; pool_ = nullptr; staging_ = nullptr; hwnd_ = 0;
  }
  CaptureResult Frame(const protocol::ContextRecord& target, std::vector<std::uint8_t>& pixels, Json& transform, std::uint64_t& tick) {
    if (hwnd_ != target.hwnd) {
      Close();
      const auto factory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
      GraphicsCaptureItem item{nullptr};
      check_hresult(factory->CreateForWindow(ToHwnd(target.hwnd), winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
      size_ = item.Size();
      pool_ = Direct3D11CaptureFramePool::CreateFreeThreaded(runtime_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size_);
      session_ = pool_.CreateCaptureSession(item);
      session_.StartCapture(); hwnd_ = target.hwnd;
    }
    auto frame = pool_.TryGetNextFrame();
    if (!frame) return CaptureResult::Empty;
    // Drain queued frames to the newest real sample; display repeats keep their source QPC separately.
    for (auto next = pool_.TryGetNextFrame(); next; next = pool_.TryGetNextFrame()) { frame.Close(); frame = std::move(next); }
    const auto content = frame.ContentSize();
    if (content.Width <= 0 || content.Height <= 0) { frame.Close(); return CaptureResult::Unavailable; }
    if (content.Width != size_.Width || content.Height != size_.Height) {
      frame.Close(); size_ = content;
      pool_.Recreate(runtime_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size_);
      staging_ = nullptr; return CaptureResult::Unavailable;
    }
    RECT rectangle{};
    if (FAILED(DwmGetWindowAttribute(ToHwnd(target.hwnd), DWMWA_EXTENDED_FRAME_BOUNDS, &rectangle, sizeof(rectangle)))
      || rectangle.right - rectangle.left != content.Width || rectangle.bottom - rectangle.top != content.Height) { frame.Close(); return CaptureResult::Unavailable; }
    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture;
    check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
    D3D11_TEXTURE2D_DESC description{}; texture->GetDesc(&description);
    if (!staging_) {
      description.Usage = D3D11_USAGE_STAGING; description.BindFlags = 0; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ; description.MiscFlags = 0;
      check_hresult(device_->CreateTexture2D(&description, nullptr, staging_.put()));
    }
    context_->CopyResource(staging_.get(), texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check_hresult(context_->Map(staging_.get(), 0, D3D11_MAP_READ, 0, &mapped));
    const double scale = std::min({1.0, static_cast<double>(kWidth) / content.Width, static_cast<double>(kHeight) / content.Height});
    const auto width = static_cast<UINT>(std::floor(content.Width * scale)), height = static_cast<UINT>(std::floor(content.Height * scale));
    const UINT offsetX = (kWidth - width) / 2, offsetY = (kHeight - height) / 2;
    std::fill(pixels.begin(), pixels.end(), 0);
    for (UINT y = 0; y < height; ++y) {
      const auto sourceY = std::min(static_cast<UINT>(content.Height - 1), static_cast<UINT>(y / scale));
      const auto* row = static_cast<const BYTE*>(mapped.pData) + static_cast<std::size_t>(sourceY) * mapped.RowPitch;
      auto* output = pixels.data() + (static_cast<std::size_t>(kHeight - 1 - offsetY - y) * kWidth + offsetX) * 4;
      for (UINT x = 0; x < width; ++x) {
        const auto sourceX = std::min(static_cast<UINT>(content.Width - 1), static_cast<UINT>(x / scale));
        std::copy_n(row + sourceX * 4, 4, output + x * 4);
      }
    }
    context_->Unmap(staging_.get(), 0);
    const auto relative = frame.SystemRelativeTime().count();
    tick = static_cast<std::uint64_t>(static_cast<long double>(relative) * static_cast<long double>(QpcFrequency()) / static_cast<long double>(kTicksPerSecond));
    transform = {{"sourceWidth", content.Width}, {"sourceHeight", content.Height}, {"offsetX", offsetX}, {"offsetY", offsetY},
      {"scale", scale}, {"sourceLeft", rectangle.left}, {"sourceTop", rectangle.top}};
    frame.Close(); return CaptureResult::Frame;
  }
 private:
  com_ptr<ID3D11Device> device_;
  com_ptr<ID3D11DeviceContext> context_;
  com_ptr<ID3D11Texture2D> staging_;
  IDirect3DDevice runtime_{nullptr};
  Direct3D11CaptureFramePool pool_{nullptr};
  GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 size_{};
  std::uint64_t hwnd_ = 0;
};
com_ptr<IMFSourceReader> Reader(const std::filesystem::path& file, bool decode) {
  if (Reparse(file)) throw std::runtime_error("invalid_media");
  com_ptr<IMFSourceReader> reader;
  com_ptr<IMFAttributes> attributes;
  if (decode) {
    check_hresult(MFCreateAttributes(attributes.put(), 1));
    check_hresult(attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE));
  }
  check_hresult(MFCreateSourceReaderFromURL(file.c_str(), attributes.get(), reader.put()));
  check_hresult(reader->SetStreamSelection(kAllReaderStreams, FALSE));
  check_hresult(reader->SetStreamSelection(kFirstReaderVideoStream, TRUE));
  if (decode) {
    auto output = VideoType(MFVideoFormat_RGB32);
    check_hresult(reader->SetCurrentMediaType(kFirstReaderVideoStream, nullptr, output.get()));
  }
  return reader;
}
void SavePng(const std::filesystem::path& file, IMFSample* sample, LONG defaultStride) {
  com_ptr<IMFMediaBuffer> buffer;
  check_hresult(sample->ConvertToContiguousBuffer(buffer.put()));
  std::vector<BYTE> topDown(static_cast<std::size_t>(kWidth) * kHeight * 4);
  const auto buffer2d = buffer.try_as<IMF2DBuffer>();
  if (buffer2d) {
    BYTE* scanline = nullptr; LONG pitch = 0;
    check_hresult(buffer2d->Lock2D(&scanline, &pitch));
    const auto rowBytes = static_cast<LONG>(kWidth * 4);
    if (!scanline || (pitch > -rowBytes && pitch < rowBytes)) { buffer2d->Unlock2D(); throw std::runtime_error("decoded_stride_invalid"); }
    for (UINT y = 0; y < kHeight; ++y) std::copy_n(scanline + static_cast<std::ptrdiff_t>(y) * pitch, kWidth * 4, topDown.data() + static_cast<std::size_t>(y) * kWidth * 4);
    check_hresult(buffer2d->Unlock2D());
  } else {
    BYTE* data = nullptr; DWORD length = 0;
    check_hresult(buffer->Lock(&data, nullptr, &length));
    const auto pitch = static_cast<std::int64_t>(defaultStride);
    const auto rowBytes = pitch < 0 ? -pitch : pitch;
    if (rowBytes < kWidth * 4 || static_cast<std::uint64_t>(rowBytes) * kHeight > length) { buffer->Unlock(); throw std::runtime_error("decoded_size_invalid"); }
    const BYTE* scanline = pitch < 0 ? data + static_cast<std::ptrdiff_t>(kHeight - 1) * rowBytes : data;
    for (UINT y = 0; y < kHeight; ++y) std::copy_n(scanline + static_cast<std::ptrdiff_t>(y) * defaultStride, kWidth * 4, topDown.data() + static_cast<std::size_t>(y) * kWidth * 4);
    check_hresult(buffer->Unlock());
  }
  for (std::size_t offset = 3; offset < topDown.size(); offset += 4) topDown[offset] = 255;
  if (std::filesystem::exists(file) || Reparse(file)) throw std::runtime_error("output_exists");
  com_ptr<IWICImagingFactory> factory;
  check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
  com_ptr<IWICStream> stream;
  check_hresult(factory->CreateStream(stream.put())); check_hresult(stream->InitializeFromFilename(file.c_str(), GENERIC_WRITE));
  com_ptr<IWICBitmapEncoder> encoder;
  check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
  check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
  com_ptr<IWICBitmapFrameEncode> frame; com_ptr<IPropertyBag2> properties;
  check_hresult(encoder->CreateNewFrame(frame.put(), properties.put())); check_hresult(frame->Initialize(properties.get()));
  check_hresult(frame->SetSize(kWidth, kHeight));
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  check_hresult(frame->SetPixelFormat(&format));
  if (format != GUID_WICPixelFormat32bppBGRA) throw std::runtime_error("png_format_invalid");
  check_hresult(frame->WritePixels(kHeight, kWidth * 4, static_cast<UINT>(topDown.size()), topDown.data()));
  check_hresult(frame->Commit()); check_hresult(encoder->Commit());
}
}  // namespace

std::uint64_t QpcTicks() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return static_cast<std::uint64_t>(value.QuadPart); }
std::uint64_t QpcFrequency() { LARGE_INTEGER value{}; QueryPerformanceFrequency(&value); return static_cast<std::uint64_t>(value.QuadPart); }

struct TaskVideo::Impl {
  Impl(std::wstring dir, std::wstring policy, HookThread& hook, std::uint64_t start, unsigned seconds)
    : directory(std::move(dir)), policyPath(std::move(policy)), hooks(hook), origin(start), frequency(QpcFrequency()), durationLimit(seconds * 1000.0),
      ready(Own(CreateEventW(nullptr, TRUE, FALSE, nullptr))), wake(Own(CreateEventW(nullptr, FALSE, FALSE, nullptr))) {}
  std::filesystem::path directory;
  std::wstring policyPath;
  HookThread& hooks;
  std::uint64_t origin, frequency;
  double durationLimit;
  UniqueHandle ready, wake;
  std::atomic<bool> paused{false}, stop{false}, failed{false}, initialized{false};
  std::atomic<bool> completed{false};
  std::mutex frameMutex;
  std::thread thread;
  void Run() {
    try {
      RuntimeScope apartment;
      MfScope mf;
      CheckDirectory(directory);
      auto packageLease = PackageLease(directory, false);
      std::filesystem::create_directory(directory / L"parts"); CheckDirectory(directory / L"parts");
      AtomicJson(directory / L"native-clock.json", {{"qpcOrigin", std::to_string(origin)}, {"qpcFrequency", std::to_string(frequency)}});
      auto indexFile = Own(CreateFileW((directory / L"frames.jsonl").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      auto gapFile = Own(CreateFileW((directory / L"gaps.jsonl").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (!indexFile || !gapFile) throw std::runtime_error("index_open_failed");
      WindowCapture capture; capture.Init();
      std::vector<std::uint8_t> pixels(static_cast<std::size_t>(kWidth) * kHeight * 4);
      std::vector<std::uint8_t> sourcePixels(pixels.size());
      bool skipIdle = false;
      if (std::filesystem::exists(directory / L"recording-options.json")) {
        const auto options = LoadJson(directory / L"recording-options.json");
        if (!options.is_object() || options.size() != 2 || options.at("version") != 1
          || (options.at("idleTimeoutMs") != 0 && options.at("idleTimeoutMs") != 10000)) throw std::runtime_error("recording_options_invalid");
        skipIdle = options.at("idleTimeoutMs") == 10000;
      }
      IdleVideoTimeline timeline(skipIdle);
      std::vector<std::uint8_t> lastPixels(pixels.size());
      std::string lastIdentity;
      const auto persistIdle = [&] {
        if (!skipIdle) return;
        Json spans = Json::array();
        for (const auto& [start, end] : timeline.Spans()) spans.push_back({{"startMs", start}, {"endMs", end}});
        AtomicJson(directory / L"idle-spans.json", {{"version", 1}, {"spans", spans},
          {"activeStartMs", timeline.IdleStart() ? Json(*timeline.IdleStart()) : Json(nullptr)}});
      };
      persistIdle();
      std::optional<protocol::ContextRecord> sourceWindow;
      Json sourceTransform = nullptr;
      std::string sourcePolicy;
      std::uint64_t sourceTick = 0, sourceGeneration = 0;
      const auto invalidate = [&] {
        if (sourceWindow) std::fill(sourcePixels.begin(), sourcePixels.end(), 0);
        sourceWindow.reset(); sourceTransform = nullptr; sourcePolicy.clear(); sourceTick = 0;
        capture.Close();
      };
      Encoder encoder;
      bool encoderOpen = true;
      unsigned part = 1, partFrame = 0;
      std::uint64_t frameIndex = 0, previous = origin;
      double partStart = 0;
      auto file = directory / L"parts" / PartName(part, L"mp4"); encoder.Open(file);
      std::string gapReason = "unavailable"; double gapStart = 0;
      HMONITOR recordingMonitor = nullptr; std::uint32_t recordingDpi = 0;
      const auto gap = [&](std::string reason, double now) {
        if (reason == gapReason) return;
        if (!gapReason.empty()) WriteAll(gapFile.get(), DumpJson({{"startMs", gapStart}, {"endMs", now}, {"reason", gapReason}}) + "\n");
        gapReason = std::move(reason); gapStart = now;
      };
      const auto seal = [&](double end) {
        encoder.Close(static_cast<LONGLONG>((end - partStart) * 10000));
        if (!FlushFileBuffers(indexFile.get()) || !FlushFileBuffers(gapFile.get())) throw std::runtime_error("index_flush_failed");
        auto sealed = Own(CreateFileW(file.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!sealed || !FlushFileBuffers(sealed.get())) throw std::runtime_error("video_flush_failed");
        sealed.reset();
        AtomicJson(directory / L"parts" / PartName(part, L"json"), {{"index", part}, {"startMs", partStart},
          {"durationMs", end - partStart}, {"bytes", std::filesystem::file_size(file)}, {"sha256", Sha256Hex(Read(file, 64 * 1024 * 1024))}});
      };
      encoder.Push(pixels, 0);
      WriteAll(indexFile.get(), DumpJson({{"index", 0}, {"timeMs", 0}, {"qpc", std::to_string(origin)}, {"partId", "part-000001"},
        {"partFrame", 0}, {"window", nullptr}, {"blank", true}, {"transform", nullptr}}) + "\n");
      frameIndex = 1; partFrame = 1;
      initialized.store(true); SetEvent(ready.get());
      while (!stop.load() && Elapsed(QpcTicks(), origin, frequency) < durationLimit) {
        const auto begin = QpcTicks();
        {
          std::lock_guard lock(frameMutex);
          auto tick = begin;
          Json window = nullptr, transform = nullptr;
          std::string reason = paused.load() ? "paused" : "unauthorized";
          bool captured = false, repeated = false;
          if (!paused.load()) {
            const auto generation = hooks.Generation();
            const auto hwnd = ForegroundWindow();
            std::string refusal;
            const auto before = ReadWindowContext(hwnd, refusal);
            const auto policyFile = ReadPolicyFile(policyPath, true);
            const auto parsed = policyFile.ok ? policy::Parse(policyFile.bytes) : policy::Parse("");
            if (before && !before->minimized && parsed.policy && policy::Evaluate(*parsed.policy, ToTarget(*before), CanonicalizePath).verdict == policy::Verdict::Allowed) {
              reason = "unavailable";
              const auto monitor = MonitorFromWindow(ToHwnd(hwnd), MONITOR_DEFAULTTONULL);
              if (!recordingMonitor && monitor) { recordingMonitor = monitor; recordingDpi = before->dpi; }
              const auto name = std::filesystem::path(text::FromUtf8(before->executable).value_or(L"")).filename().wstring();
              const bool remote = text::EqualsOrdinalIgnoreCase(name, L"mstsc.exe") || text::EqualsOrdinalIgnoreCase(name, L"msrdc.exe")
                || text::EqualsOrdinalIgnoreCase(name, L"wfica32.exe") || text::EqualsOrdinalIgnoreCase(name, L"cdviewer.exe");
              if (!remote && monitor == recordingMonitor && before->dpi == recordingDpi) {
                const bool sameSource = sourceWindow && protocol::SameInstance(*sourceWindow, *before)
                  && sourceWindow->bounds == before->bounds && sourceWindow->dpi == before->dpi
                  && sourceGeneration == generation && sourcePolicy == policyFile.sha256;
                if (sourceWindow && !sameSource) invalidate();
                CaptureResult result = CaptureResult::Unavailable;
                try { result = capture.Frame(*before, pixels, transform, tick); } catch (...) { reason = "capture_failed"; }
                const auto after = ReadWindowContext(hwnd, refusal);
                const bool verified = hooks.Barrier(250) && hooks.Generation() == generation && ForegroundWindow() == hwnd
                  && after && protocol::SameInstance(*before, *after) && before->bounds == after->bounds && before->dpi == after->dpi;
                if (!verified || result == CaptureResult::Unavailable) invalidate();
                else if (result == CaptureResult::Frame) {
                  const auto now = QpcTicks();
                  if (tick < origin || tick < hooks.GenerationQpc() || tick <= sourceTick || tick > now || Elapsed(now, tick, frequency) > 200) invalidate();
                  else {
                    sourcePixels = pixels; sourceWindow = *before; sourceTransform = transform;
                    sourceTick = tick; sourceGeneration = generation; sourcePolicy = policyFile.sha256; captured = true;
                    // A real sample can arrive after a later display timestamp was already written.
                    // Keep its source time; a derived display frame is not fresh export evidence.
                    repeated = tick <= previous;
                    if (repeated) tick = now;
                  }
                } else if (sourceWindow) {
                  // An empty pool is normal for a static window. Revalidate the cached identity
                  // on every tick; never carry its pixels through pause or a scope/foreground change.
                  pixels = sourcePixels; transform = sourceTransform; tick = QpcTicks(); captured = true; repeated = true;
                }
              } else invalidate();
              if (captured) {
                window = protocol::ContextToJson(*before, std::nullopt);
                window.erase("title"); window.erase("minimized"); window.erase("generation");
              }
            } else invalidate();
          } else invalidate();
          if (!captured) { tick = QpcTicks(); transform = nullptr; std::fill(pixels.begin(), pixels.end(), 0); }
          if (tick <= previous && frameIndex != 0) tick = previous + 1;
          const double now = Elapsed(tick, origin, frequency);
          gap(captured ? "" : reason, now);
          const auto identity = DumpJson(window) + DumpJson(transform) + (captured ? std::to_string(sourceGeneration) + sourcePolicy : reason);
          const bool changed = identity != lastIdentity || pixels != lastPixels;
          const auto wasIdle = timeline.IdleStart();
          const auto oldSpanCount = timeline.Spans().size();
          const bool write = timeline.Observe(now, changed || paused.load());
          if (timeline.IdleStart() != wasIdle || timeline.Spans().size() != oldSpanCount) persistIdle();
          if (changed) { lastPixels = pixels; lastIdentity = identity; }
          if (!write && encoderOpen) {
            // Seal the captured prefix now, rather than leaving an unfinished MP4
            // open throughout a potentially long model wait.
            seal(timeline.VideoTime(now)); encoderOpen = false;
          }
          if (write) {
            const auto videoTime = timeline.VideoTime(now);
            if (!encoderOpen || (videoTime - partStart >= 10000 && partFrame > 0)) {
              if (encoderOpen) seal(videoTime);
              ++part; partFrame = 0; partStart = videoTime;
              file = directory / L"parts" / PartName(part, L"mp4"); encoder.Open(file);
              encoderOpen = true;
            }
            encoder.Push(pixels, static_cast<LONGLONG>((videoTime - partStart) * 10000));
            const std::string partId = "part-" + text::ToUtf8(PartName(part, L""));
            Json indexed = {{"index", frameIndex}, {"timeMs", now}, {"qpc", std::to_string(tick)},
              {"partId", partId.substr(0, partId.size() - 1)}, {"partFrame", partFrame}, {"window", window}, {"blank", !captured},
              {"transform", transform}, {"repeated", repeated}};
            if (captured) indexed["sourceTicks"] = std::to_string(sourceTick);
            if (skipIdle) indexed["videoTimeMs"] = videoTime;
            WriteAll(indexFile.get(), DumpJson(indexed) + "\n");
            previous = tick; ++frameIndex; ++partFrame;
          }
        }
        const double used = Elapsed(QpcTicks(), begin, frequency);
        WaitForSingleObject(wake.get(), used < 1000.0 / kFps ? static_cast<DWORD>(std::ceil(1000.0 / kFps - used)) : 0);
      }
      capture.Close();
      const auto end = std::max(std::min(QpcTicks(), origin + static_cast<std::uint64_t>(durationLimit * static_cast<double>(frequency) / 1000)), previous + 1);
      const auto elapsed = Elapsed(end, origin, frequency);
      timeline.Finish(elapsed); persistIdle();
      gap("", elapsed); if (encoderOpen) seal(timeline.VideoTime(elapsed));
      AtomicJson(directory / L"native-completion.json", {{"durationMs", Elapsed(end, origin, frequency)}, {"complete", true}, {"partCount", part}});
      completed.store(true);
    } catch (...) { failed.store(true); SetEvent(ready.get()); }
  }
};
TaskVideo::TaskVideo(std::wstring directory, std::wstring policy, HookThread& hooks, std::uint64_t origin, unsigned seconds)
  : impl_(std::make_unique<Impl>(std::move(directory), std::move(policy), hooks, origin, seconds)) {}
TaskVideo::~TaskVideo() { Stop(); }
bool TaskVideo::Start() {
  impl_->thread = std::thread([this] { impl_->Run(); });
  return WaitForSingleObject(impl_->ready.get(), 8000) == WAIT_OBJECT_0 && impl_->initialized.load() && !impl_->failed.load();
}
void TaskVideo::Pause(bool paused) { std::lock_guard lock(impl_->frameMutex); impl_->paused.store(paused); SetEvent(impl_->wake.get()); }
void TaskVideo::Stop() { impl_->stop.store(true); SetEvent(impl_->wake.get()); if (impl_->thread.joinable()) impl_->thread.join(); }
bool TaskVideo::Failed() const { return impl_->failed.load(); }
bool TaskVideo::Done() const { return impl_->completed.load(); }

#if MEMMY_HISTORY_TEST_HOOKS
int TaskVideo::WriteFixture(const std::wstring& folder) {
  try {
    ComScope apartment(COINIT_MULTITHREADED); if (!apartment.Ok()) return 5;
    MfScope mf;
    const std::filesystem::path directory(folder); CheckDirectory(directory); std::filesystem::create_directory(directory / L"parts");
    AtomicJson(directory / L"native-clock.json", {{"qpcOrigin", "1000000"}, {"qpcFrequency", "10000"}});
    std::string frames;
    for (unsigned part = 1; part <= 2; ++part) {
      Encoder encoder; const auto file = directory / L"parts" / PartName(part, L"mp4"); encoder.Open(file);
      for (unsigned frame = 0; frame < 3; ++frame) {
        std::vector<std::uint8_t> pixels(static_cast<std::size_t>(kWidth) * kHeight * 4, 0);
        for (UINT y = 0; y < kHeight; ++y) for (UINT x = 0; x < kWidth; ++x) {
          auto* pixel = pixels.data() + (static_cast<std::size_t>(kHeight - y - 1) * kWidth + x) * 4;
          pixel[y < kHeight / 2 ? 2 : 0] = static_cast<std::uint8_t>(220 - frame * 20); pixel[3] = 255;
        }
        encoder.Push(pixels, frame * 3000000LL);
        const unsigned index = (part - 1) * 3 + frame;
        frames += DumpJson({{"index", index}, {"timeMs", (part - 1) * 1000 + frame * 300}, {"qpc", std::to_string(1000000 + (part - 1) * 10000 + frame * 3000)},
          {"partId", "part-" + text::ToUtf8(PartName(part, L"")).substr(0, 6)}, {"partFrame", frame}, {"blank", false}, {"window", nullptr}, {"transform", nullptr}}) + "\n";
      }
      encoder.Close(10000000);
      AtomicJson(directory / L"parts" / PartName(part, L"json"), {{"index", part}, {"startMs", (part - 1) * 1000}, {"durationMs", 1000},
        {"bytes", std::filesystem::file_size(file)}, {"sha256", Sha256Hex(Read(file, 64 * 1024 * 1024))}});
    }
    auto handle = Own(CreateFileW((directory / L"frames.jsonl").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!handle) throw std::runtime_error("fixture_exists"); WriteAll(handle.get(), frames); handle.reset();
    AtomicJson(directory / L"native-completion.json", {{"durationMs", 2000}, {"complete", true}, {"partCount", 2}});
    return 0;
  } catch (...) { Diagnostic("task_fixture_failed"); return 5; }
}
#endif

int TaskVideo::Finalize(const std::wstring& folder) {
  try {
    ComScope apartment(COINIT_MULTITHREADED); if (!apartment.Ok()) return 5;
    MfScope mf;
    const std::filesystem::path directory(folder); CheckDirectory(directory); CheckDirectory(directory / L"parts");
    auto packageLease = PackageLease(directory, true);
    const auto clock = LoadJson(directory / L"native-clock.json");
    Json parts = Json::array(), gaps = Json::array();
    bool complete = std::filesystem::exists(directory / L"native-completion.json");
    double duration = complete ? LoadJson(directory / L"native-completion.json").at("durationMs").get<double>() : 0;
    // Every idle transition can seal an extra partial chunk in addition to
    // the normal ten-second chunks within the twenty-minute source limit.
    for (unsigned index = 1; index <= 241; ++index) {
      try {
      const auto sidecar = directory / L"parts" / PartName(index, L"json");
      if (!std::filesystem::exists(sidecar)) break;
      auto part = LoadJson(sidecar);
      if (part.at("index").get<unsigned>() != index || part.at("startMs").get<double>() < 0 || part.at("durationMs").get<double>() <= 0) throw std::runtime_error("part_invalid");
      const auto mediaFile = directory / L"parts" / PartName(index, L"mp4");
      if (part.at("bytes").get<std::uintmax_t>() != std::filesystem::file_size(mediaFile)
        || part.at("sha256").get<std::string>() != Sha256Hex(Read(mediaFile, 64 * 1024 * 1024))) throw std::runtime_error("part_integrity_invalid");
      auto reader = Reader(directory / L"parts" / PartName(index, L"mp4"), false);
      com_ptr<IMFMediaType> type; check_hresult(reader->GetNativeMediaType(kFirstReaderVideoStream, 0, type.put()));
      GUID subtype{}; check_hresult(type->GetGUID(MF_MT_SUBTYPE, &subtype));
      UINT32 width = 0, height = 0; check_hresult(MFGetAttributeSize(type.get(), MF_MT_FRAME_SIZE, &width, &height));
      if (subtype != MFVideoFormat_H264 || width != kWidth || height != kHeight) throw std::runtime_error("part_invalid");
      parts.push_back(part); duration = std::max(duration, part.at("startMs").get<double>() + part.at("durationMs").get<double>());
      } catch (...) { complete = false; break; }
    }
    if (parts.empty()) throw std::runtime_error("no_sealed_parts");
    if (complete && LoadJson(directory / L"native-completion.json").at("partCount").get<std::size_t>() != parts.size()) complete = false;
    // Retain only index rows from sealed parts. An unfinished MP4 tail is never treated as playable.
    const std::string indexBytes = Read(directory / L"frames.jsonl", 64 * 1024 * 1024);
    std::string verified; std::size_t offset = 0; double lastFrame = 0, lastVerifiedFrame = 0;
    while (offset < indexBytes.size()) {
      const auto newline = indexBytes.find('\n', offset); if (newline == std::string::npos) { complete = false; break; }
      const auto row = ParseJsonStrict(std::string_view(indexBytes).substr(offset, newline - offset), 16); if (!row) { complete = false; break; }
      const std::string partId = row->at("partId").get<std::string>();
      lastFrame = std::max(lastFrame, row->at("timeMs").get<double>());
      std::optional<std::uint64_t> number;
      if (partId.size() == 11 && partId.starts_with("part-") && partId.substr(5).find_first_not_of("0123456789") == std::string::npos) number = std::stoull(partId.substr(5));
      if (!number || *number > parts.size()) { complete = false; } else {
        verified.append(indexBytes, offset, newline - offset + 1);
        lastVerifiedFrame = row->at("timeMs").get<double>();
      }
      offset = newline + 1;
    }
    const double sealedEnd = parts.back().at("startMs").get<double>() + parts.back().at("durationMs").get<double>();
    const bool compact = std::filesystem::exists(directory / L"idle-spans.json");
    Json idleSpans = Json::array();
    if (compact) {
      const auto idle = LoadJson(directory / L"idle-spans.json");
      if (idle.at("version") != 1 || !idle.at("spans").is_array()) throw std::runtime_error("idle_clock_invalid");
      idleSpans = idle.at("spans");
      if (!idle.at("activeStartMs").is_null()) {
        const auto start = idle.at("activeStartMs").get<double>();
        duration = std::max({duration, lastFrame, start});
        if (duration > start) idleSpans.push_back({{"startMs", start}, {"endMs", duration}});
      }
      double previousEnd = 0;
      for (const auto& span : idleSpans) {
        const auto start = span.at("startMs").get<double>(), end = span.at("endMs").get<double>();
        if (!std::isfinite(start) || !std::isfinite(end) || start < previousEnd || end <= start || end > 1200200) throw std::runtime_error("idle_clock_invalid");
        previousEnd = end;
      }
    }
    const auto sourceEnd = compact ? lastVerifiedFrame : sealedEnd;
    if (!complete) gaps.push_back({{"startMs", sourceEnd}, {"endMs", std::max({sourceEnd, lastFrame, duration})}, {"reason", "missing_tail"}});
    duration = std::max(duration, lastFrame);
    {
      const auto temporary = directory / L"frames.verified.jsonl";
      if (Reparse(temporary)) throw std::runtime_error("invalid_file");
      auto handle = Own(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (!handle) throw std::runtime_error("write_failed"); WriteAll(handle.get(), verified);
      if (!FlushFileBuffers(handle.get())) throw std::runtime_error("flush_failed"); handle.reset();
      if (!MoveFileExW(temporary.c_str(), (directory / L"frames.jsonl").c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("rename_failed");
    }
    if (std::filesystem::exists(directory / L"gaps.jsonl")) {
      std::istringstream stream(Read(directory / L"gaps.jsonl")); std::string line;
      while (std::getline(stream, line)) { const auto row = ParseJsonStrict(line, 8); if (row) gaps.push_back(*row); }
    }
    const auto media = [&](bool done, Json error) {
      Json value = {{"version", 1}, {"durationMs", duration}, {"qpcOrigin", clock.at("qpcOrigin")},
        {"qpcFrequency", clock.at("qpcFrequency")}, {"width", kWidth}, {"height", kHeight}, {"complete", done},
        {"error", error}, {"gaps", gaps}, {"parts", parts}};
      if (compact) { value["idleSpans"] = idleSpans; value["videoDurationMs"] = sealedEnd; }
      return value;
    };
    AtomicJson(directory / L"native-media.json", media(false, "task_merge_incomplete"));
    const auto temporary = directory / L"recording.partial.mp4";
    if (Reparse(temporary) || Reparse(directory / L"recording.mp4")) throw std::runtime_error("invalid_file");
    std::filesystem::remove(temporary);
    com_ptr<IMFSinkWriter> writer; check_hresult(MFCreateSinkWriterFromURL(temporary.c_str(), nullptr, nullptr, writer.put()));
    DWORD outputStream = 0; bool started = false;
    std::vector<BYTE> header;
    for (const auto& part : parts) {
      auto reader = Reader(directory / L"parts" / PartName(part.at("index").get<unsigned>(), L"mp4"), false);
      com_ptr<IMFMediaType> type; check_hresult(reader->GetNativeMediaType(kFirstReaderVideoStream, 0, type.put()));
      UINT32 size = 0; check_hresult(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size));
      std::vector<BYTE> currentHeader(size); check_hresult(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, currentHeader.data(), size, nullptr));
      if (!started) {
        header = currentHeader;
        check_hresult(writer->AddStream(type.get(), &outputStream)); check_hresult(writer->SetInputMediaType(outputStream, type.get(), nullptr));
        check_hresult(writer->BeginWriting()); started = true;
      } else if (header != currentHeader) throw std::runtime_error("part_codec_changed");
      bool first = true;
      for (;;) {
        DWORD flags = 0; LONGLONG timestamp = 0; com_ptr<IMFSample> sample;
        check_hresult(reader->ReadSample(kFirstReaderVideoStream, 0, nullptr, &flags, &timestamp, sample.put()));
        if ((flags & MF_SOURCE_READERF_ERROR) != 0) throw std::runtime_error("part_decode_failed");
        if (sample) {
          if (first && MFGetAttributeUINT32(sample.get(), MFSampleExtension_CleanPoint, FALSE) == FALSE) throw std::runtime_error("part_not_independent");
          first = false;
          check_hresult(sample->SetSampleTime(timestamp + static_cast<LONGLONG>(part.at("startMs").get<double>() * 10000)));
          check_hresult(writer->WriteSample(outputStream, sample.get()));
        }
        if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) break;
      }
      if (first) throw std::runtime_error("part_empty");
    }
    check_hresult(writer->Finalize()); writer = nullptr;
    if (!MoveFileExW(temporary.c_str(), (directory / L"recording.mp4").c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("merge_rename_failed");
    AtomicJson(directory / L"native-media.json", media(complete, complete ? Json(nullptr) : Json("recording_interrupted")));
    return 0;
  } catch (...) { Diagnostic("task_finalize_failed"); return 5; }
}
int TaskVideo::ExportFrames(const std::wstring& folder, const std::wstring& destination) {
  try {
    ComScope apartment(COINIT_MULTITHREADED); if (!apartment.Ok()) return 5;
    MfScope mf;
    const std::filesystem::path directory(folder), output(destination);
    CheckDirectory(directory); CheckDirectory(directory / L"parts"); CheckDirectory(output);
    std::filesystem::create_directory(output / L"frames"); CheckDirectory(output / L"frames");
    const auto requests = LoadJson(output / L"frame-requests.json");
    if (!requests.is_array() || requests.size() > 2000) throw std::runtime_error("requests_invalid");
    std::vector<Json> frames;
    std::istringstream index(Read(directory / L"frames.jsonl", 64 * 1024 * 1024)); std::string line;
    while (std::getline(index, line)) { const auto row = ParseJsonStrict(line, 16); if (!row) throw std::runtime_error("frame_invalid"); frames.push_back(*row); }
    for (unsigned part = 1; part <= 121; ++part) {
      const std::string partId = "part-" + text::ToUtf8(PartName(part, L""));
      std::vector<Json> selected;
      for (const auto& request : requests) {
        if (request.at("partId").get<std::string>() + "." != partId) continue;
        const auto frameId = request.at("frameId").get<std::size_t>();
        if (frameId >= frames.size() || frames[frameId].at("blank").get<bool>() || frames[frameId].value("repeated", false) || frames[frameId].at("partFrame") != request.at("partFrame")
          || frames[frameId].at("partId") != request.at("partId")) throw std::runtime_error("unverified_frame");
        selected.push_back(request);
      }
      if (selected.empty()) continue;
      auto reader = Reader(directory / L"parts" / PartName(part, L"mp4"), true);
      com_ptr<IMFMediaType> decodedType;
      check_hresult(reader->GetCurrentMediaType(kFirstReaderVideoStream, decodedType.put()));
      UINT32 encodedStride = 0; LONG defaultStride = 0;
      if (SUCCEEDED(decodedType->GetUINT32(MF_MT_DEFAULT_STRIDE, &encodedStride))) defaultStride = static_cast<LONG>(encodedStride);
      else check_hresult(MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1, kWidth, &defaultStride));
      unsigned frameNumber = 0; std::size_t written = 0;
      for (;;) {
        DWORD flags = 0; com_ptr<IMFSample> sample;
        check_hresult(reader->ReadSample(kFirstReaderVideoStream, 0, nullptr, &flags, nullptr, sample.put()));
        if ((flags & MF_SOURCE_READERF_ERROR) != 0) throw std::runtime_error("decode_failed");
        if (sample) {
          for (const auto& request : selected) if (request.at("partFrame").get<unsigned>() == frameNumber) {
            const auto i = request.at("i").get<unsigned>(); const auto phase = request.at("phase").get<std::string>();
            if (i > 9999 || (phase != "before" && phase != "after")) throw std::runtime_error("request_invalid");
            wchar_t name[40]{}; swprintf_s(name, L"%04u_%ls.png", i, phase == "before" ? L"before" : L"after");
            SavePng(output / L"frames" / name, sample.get(), defaultStride); ++written;
          }
          ++frameNumber;
        }
        if (written == selected.size() || (flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) break;
      }
      if (written != selected.size()) throw std::runtime_error("frame_missing");
    }
    return 0;
  } catch (...) { Diagnostic("task_frame_export_failed"); return 5; }
}
}  // namespace memmy::win
