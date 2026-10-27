// Open Dock camera host: owns the Windows virtual camera "Open Dock Camera".
// Open Dock (Rust) does the phone link and pipes the phone's H.264 here; this decodes it and hands NV12 frames
// to opendock_vcam.dll (loaded by Windows Frame Server) through shared memory.
//   dockcam.exe              run: stdin = frames from Open Dock, stdout = status lines. Exits when stdin closes.
//   dockcam.exe --install    elevated: copy the DLL to Program Files and register it.
//   dockcam.exe --uninstall  elevated: undo --install.
//   dockcam.exe --check      exit 0 when the DLL is registered and current.
// stdin: u8 type, u32 length (big-endian), payload. 1 CONFIG (SPS+PPS), 2 FRAME (u8 key, i64 ptsUs BE, Annex B),
//        3 FLAGS (u8: 1 mirror, 2 rotate 180), 4 RESET (new source: forget config, wait for a keyframe).
// stdout: "READY", "ERR <hex>", "C1" / "C0" (a Windows app started / stopped using the camera).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "common.h"
#include <objbase.h>
#include <shellapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mftransform.h>
#include <mfvirtualcamera.h>
#include <wmcodecdsp.h>
#include <codecapi.h>
#include <sddl.h>
#include <wrl/client.h>
#include <cstdio>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

static SharedFrame* g_sf;
static UINT g_flags;

static void OpenShared() {
    if (g_sf) return;
    PSECURITY_DESCRIPTOR sd = nullptr;
    ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;WD)(A;;GA;;;SY)", SDDL_REVISION_1, &sd, nullptr);
    SECURITY_ATTRIBUTES sa = {sizeof(sa), sd, FALSE};
    HANDLE map = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, sizeof(SharedFrame), OPENCAM_MAP_NAME);
    if (!map) map = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, OPENCAM_MAP_NAME);
    if (sd) LocalFree(sd);
    if (map) g_sf = (SharedFrame*)MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedFrame));
}

static bool ConsumerActive() { return g_sf && (LONGLONG)GetTickCount64() - g_sf->consumerTick < 1500; }

static void PublishFrame(const BYTE* p, UINT w, UINT h, UINT stride, UINT planeH) {
    h &= ~1u;
    if (!g_sf || !w || !h || w > MAX_W || h > MAX_H) return;
    InterlockedIncrement(&g_sf->seq);
    g_sf->width = w;
    g_sf->height = h;
    g_sf->flags = g_flags;
    for (UINT y = 0; y < h; y++) memcpy(g_sf->data + (size_t)y * w, p + (size_t)y * stride, w);
    const BYTE* uv = p + (size_t)stride * planeH;
    BYTE* duv = g_sf->data + (size_t)w * h;
    for (UINT y = 0; y < h / 2; y++) memcpy(duv + (size_t)y * w, uv + (size_t)y * stride, w);
    g_sf->frameTick = (LONGLONG)GetTickCount64();
    InterlockedIncrement(&g_sf->seq);
}

// ---------------------------------------------------------------- H.264 decoder (Media Foundation), from openCam
struct Decoder {
    ComPtr<IMFTransform> t;
    UINT w = 0, h = 0, stride = 0, dispH = 0;

    bool Init() {
        if (FAILED(CoCreateInstance(CLSID_CMSH264DecoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&t)))) return false;
        ComPtr<IMFAttributes> a;
        if (SUCCEEDED(t->GetAttributes(&a))) a->SetUINT32(CODECAPI_AVLowLatencyMode, TRUE);
        ComPtr<IMFMediaType> in;
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        if (FAILED(t->SetInputType(0, in.Get(), 0)) || !SetOut()) { t.Reset(); return false; }
        t->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        t->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        return true;
    }

    bool SetOut() {
        for (DWORD i = 0;; i++) {
            ComPtr<IMFMediaType> mt;
            if (FAILED(t->GetOutputAvailableType(0, i, &mt))) return false;
            GUID sub;
            mt->GetGUID(MF_MT_SUBTYPE, &sub);
            if (sub != MFVideoFormat_NV12) continue;
            if (FAILED(t->SetOutputType(0, mt.Get(), 0))) return false;
            MFGetAttributeSize(mt.Get(), MF_MT_FRAME_SIZE, &w, &h);
            stride = MFGetAttributeUINT32(mt.Get(), MF_MT_DEFAULT_STRIDE, w);
            MFVideoArea area;
            dispH = SUCCEEDED(mt->GetBlob(MF_MT_MINIMUM_DISPLAY_APERTURE, (UINT8*)&area, sizeof area, nullptr)) ? area.Area.cy : h;
            return true;
        }
    }

    void Feed(const BYTE* data, size_t n, LONGLONG ptsUs) {
        if (!t && !Init()) return;
        ComPtr<IMFSample> s;
        ComPtr<IMFMediaBuffer> b;
        MFCreateSample(&s);
        MFCreateMemoryBuffer((DWORD)n, &b);
        BYTE* p;
        b->Lock(&p, nullptr, nullptr);
        memcpy(p, data, n);
        b->Unlock();
        b->SetCurrentLength((DWORD)n);
        s->AddBuffer(b.Get());
        s->SetSampleTime(ptsUs * 10);
        if (t->ProcessInput(0, s.Get(), 0) == MF_E_NOTACCEPTING) {
            Drain();
            t->ProcessInput(0, s.Get(), 0);
        }
        Drain();
    }

    void Drain() {
        for (;;) {
            MFT_OUTPUT_STREAM_INFO si = {};
            t->GetOutputStreamInfo(0, &si);
            bool provides = (si.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
            ComPtr<IMFSample> os;
            if (!provides) {
                ComPtr<IMFMediaBuffer> ob;
                MFCreateSample(&os);
                MFCreateMemoryBuffer(si.cbSize, &ob);
                os->AddBuffer(ob.Get());
            }
            MFT_OUTPUT_DATA_BUFFER out = {};
            out.pSample = os.Get();
            DWORD status = 0;
            HRESULT hr = t->ProcessOutput(0, 1, &out, &status);
            if (out.pEvents) out.pEvents->Release();
            if (hr == MF_E_TRANSFORM_STREAM_CHANGE) { if (!SetOut()) return; continue; }
            if (FAILED(hr)) return; // MF_E_TRANSFORM_NEED_MORE_INPUT or a decode error
            ComPtr<IMFMediaBuffer> cb;
            if (SUCCEEDED(out.pSample->ConvertToContiguousBuffer(&cb))) {
                BYTE* p;
                DWORD len;
                if (SUCCEEDED(cb->Lock(&p, nullptr, &len))) {
                    if (len >= (DWORD)stride * h * 3 / 2) PublishFrame(p, w, dispH, stride, h);
                    cb->Unlock();
                }
            }
            if (provides) out.pSample->Release();
        }
    }
};

// ---------------------------------------------------------------- install (elevated)
static std::wstring ExePath() { wchar_t p[MAX_PATH]; GetModuleFileNameW(nullptr, p, MAX_PATH); return p; }
static std::wstring ExeDir() { std::wstring p = ExePath(); return p.substr(0, p.rfind(L'\\')); }
static std::wstring InstallDir() { wchar_t p[MAX_PATH]; ExpandEnvironmentStringsW(L"%ProgramFiles%\\Open Dock Camera", p, MAX_PATH); return p; }
static const wchar_t* CLSID_KEY = L"Software\\Classes\\CLSID\\" OPENCAM_CLSID_STR L"\\InprocServer32";

static std::string ReadAll(const std::wstring& path) {
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return {};
    std::string d;
    char buf[65536];
    DWORD n;
    while (ReadFile(f, buf, sizeof buf, &n, nullptr) && n) d.append(buf, n);
    CloseHandle(f);
    return d;
}

static int CallDll(const std::wstring& dll, const char* fn) {
    HMODULE m = LoadLibraryW(dll.c_str());
    if (!m) return 1;
    auto f = (HRESULT(STDAPICALLTYPE*)())GetProcAddress(m, fn);
    HRESULT hr = f ? f() : E_FAIL;
    FreeLibrary(m);
    return SUCCEEDED(hr) ? 0 : 2;
}

static int Install() {
    std::wstring dst = InstallDir() + L"\\opendock_vcam.dll";
    CreateDirectoryW(InstallDir().c_str(), nullptr);
    CopyFileW((ExeDir() + L"\\opendock_vcam.dll").c_str(), dst.c_str(), FALSE); // may fail if in use; keep the old one
    return CallDll(dst, "DllRegisterServer");
}

static int Uninstall() {
    std::wstring dst = InstallDir() + L"\\opendock_vcam.dll";
    int r = CallDll(dst, "DllUnregisterServer");
    DeleteFileW(dst.c_str());
    RemoveDirectoryW(InstallDir().c_str());
    return r;
}

static bool NeedsInstall() {
    wchar_t v[MAX_PATH];
    DWORD n = sizeof v;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, CLSID_KEY, nullptr, RRF_RT_REG_SZ, nullptr, v, &n)) return true;
    if (_wcsicmp(v, (InstallDir() + L"\\opendock_vcam.dll").c_str())) return true;
    std::string local = ReadAll(ExeDir() + L"\\opendock_vcam.dll");
    return !local.empty() && local != ReadAll(v); // a different build sits next to the exe
}

// ---------------------------------------------------------------- run
static bool ReadAllIn(HANDLE h, BYTE* p, size_t n) {
    while (n) {
        DWORD r;
        if (!ReadFile(h, p, (DWORD)(n < (1u << 20) ? n : (1u << 20)), &r, nullptr) || !r) return false;
        p += r;
        n -= r;
    }
    return true;
}

static void Say(const char* fmt, unsigned v = 0) {
    char b[64];
    int n = snprintf(b, sizeof b, fmt, v);
    DWORD w;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), b, n, &w, nullptr);
}

static DWORD WINAPI WatchConsumer(void*) {
    bool last = false;
    for (;;) {
        OpenShared();
        bool now = ConsumerActive();
        if (now != last) { last = now; Say(now ? "C1\n" : "C0\n"); }
        Sleep(250);
    }
}

int wmain(int argc, wchar_t** argv) {
    std::wstring arg = argc > 1 ? argv[1] : L"";
    if (arg == L"--install") return Install();
    if (arg == L"--uninstall") return Uninstall();
    if (arg == L"--check") return NeedsInstall() ? 1 : 0;

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    OpenShared();
    ComPtr<IMFVirtualCamera> vcam;
    HRESULT hr = MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
                                       MFVirtualCameraAccess_CurrentUser, L"Open Dock Camera", OPENCAM_CLSID_STR, nullptr, 0, &vcam);
    if (SUCCEEDED(hr)) hr = vcam->Start(nullptr);
    if (FAILED(hr)) { Say("ERR %08X\n", (unsigned)hr); return 1; }
    Say("READY\n");
    CreateThread(nullptr, 0, WatchConsumer, nullptr, 0, nullptr);

    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    Decoder dec;
    std::vector<BYTE> buf, csd, joined;
    bool waitKey = true;
    BYTE hdr[5];
    while (ReadAllIn(in, hdr, 5)) {
        UINT len = ((UINT)hdr[1] << 24) | ((UINT)hdr[2] << 16) | ((UINT)hdr[3] << 8) | hdr[4];
        if (len > (32u << 20)) break;
        buf.resize(len);
        if (len && !ReadAllIn(in, buf.data(), len)) break;
        if (hdr[0] == 1) { csd = buf; waitKey = true; }
        else if (hdr[0] == 2 && len > 9) {
            bool key = buf[0] != 0;
            if (key) waitKey = false;
            if (waitKey) continue;
            LONGLONG pts = 0;
            for (int i = 1; i <= 8; i++) pts = (pts << 8) | buf[i];
            if (key && !csd.empty()) {
                joined.assign(csd.begin(), csd.end());
                joined.insert(joined.end(), buf.begin() + 9, buf.end());
                dec.Feed(joined.data(), joined.size(), pts);
            } else dec.Feed(buf.data() + 9, len - 9, pts);
        } else if (hdr[0] == 3 && len >= 1) g_flags = buf[0];
        else if (hdr[0] == 4) { csd.clear(); waitKey = true; dec = Decoder(); }
    }
    return 0;
}
