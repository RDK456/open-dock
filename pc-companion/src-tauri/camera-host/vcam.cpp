// openCam virtual camera: a Media Foundation media source that Windows Frame Server loads
// (via MFCreateVirtualCamera in the tray app) and exposes to every camera app on the system.
// Frames come from the tray app through the shared-memory SharedFrame in common.h.
#include "common.h"
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksproxy.h>
#include <ksmedia.h>
#include <sddl.h>
#include <wrl.h>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

using namespace Microsoft::WRL;

static HMODULE g_module;

// ------------------------------------------------------------------ frame source

// Nearest-neighbour NV12 scale with optional mirror / 180° rotation.
// dstPlaneH is the allocated luma height (the UV plane starts at pitch * dstPlaneH).
static void ScaleNV12(const BYTE* src, UINT sw, UINT sh, UINT flags, BYTE* dst, LONG pitch, UINT dw, UINT dh, UINT dstPlaneH) {
    bool fy = (flags & FLAG_ROT180) != 0;
    bool fx = ((flags & FLAG_MIRROR) != 0) != fy;
    std::vector<UINT> xs(dw);
    for (UINT x = 0; x < dw; x++) {
        UINT sx = (UINT)((UINT64)x * sw / dw);
        xs[x] = fx ? sw - 1 - sx : sx;
    }
    for (UINT y = 0; y < dh; y++) {
        UINT sy = (UINT)((UINT64)y * sh / dh);
        if (fy) sy = sh - 1 - sy;
        const BYTE* s = src + (size_t)sy * sw;
        BYTE* d = dst + (size_t)y * pitch;
        if (sw == dw && !fx) memcpy(d, s, dw);
        else for (UINT x = 0; x < dw; x++) d[x] = s[xs[x]];
    }
    const BYTE* suv = src + (size_t)sw * sh;
    BYTE* duv = dst + (size_t)pitch * dstPlaneH;
    UINT cw = dw / 2, ch = dh / 2, scw = sw / 2, sch = sh / 2;
    for (UINT y = 0; y < ch; y++) {
        UINT sy = (UINT)((UINT64)y * sch / ch);
        if (fy) sy = sch - 1 - sy;
        const USHORT* s = (const USHORT*)(suv + (size_t)sy * sw);
        USHORT* d = (USHORT*)(duv + (size_t)y * pitch);
        if (scw == cw && !fx) memcpy(d, s, cw * 2);
        else for (UINT x = 0; x < cw; x++) {
            UINT sx = (UINT)((UINT64)x * scw / cw);
            d[x] = s[fx ? scw - 1 - sx : sx];
        }
    }
}

static void FillBlack(BYTE* dst, LONG pitch, UINT w, UINT h, UINT planeH) {
    for (UINT y = 0; y < h; y++) memset(dst + (size_t)y * pitch, 16, w);
    for (UINT y = 0; y < h / 2; y++) memset(dst + (size_t)pitch * planeH + (size_t)y * pitch, 128, w);
}

struct FrameReader {
    HANDLE map = nullptr;
    SharedFrame* sf = nullptr;

    void Open() {
        if (sf) return;
        PSECURITY_DESCRIPTOR sd = nullptr;
        // Everyone may read/write: the tray app runs as the signed-in user, we run as LocalService.
        ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;GA;;;WD)(A;;GA;;;SY)", SDDL_REVISION_1, &sd, nullptr);
        SECURITY_ATTRIBUTES sa = {sizeof(sa), sd, FALSE};
        map = CreateFileMappingW(INVALID_HANDLE_VALUE, &sa, PAGE_READWRITE, 0, sizeof(SharedFrame), OPENCAM_MAP_NAME);
        if (!map) map = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, OPENCAM_MAP_NAME);
        if (sd) LocalFree(sd);
        if (map) sf = (SharedFrame*)MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedFrame));
    }

    ~FrameReader() {
        if (sf) UnmapViewOfFile(sf);
        if (map) CloseHandle(map);
    }

    // Copies the latest phone frame into dst, scaled to w x h. False = nothing live to show.
    bool Read(BYTE* dst, LONG pitch, UINT w, UINT h, UINT planeH) {
        Open();
        if (!sf) return false;
        sf->consumerTick = (LONGLONG)GetTickCount64();
        for (int i = 0; i < 3; i++) {
            LONG s1 = sf->seq;
            if (s1 & 1) { Sleep(1); continue; }
            UINT sw = sf->width, sh = sf->height;
            if (!sw || !sh || sw > MAX_W || sh > MAX_H || (LONGLONG)GetTickCount64() - sf->frameTick > 3000) return false;
            ScaleNV12(sf->data, sw, sh, sf->flags, dst, pitch, w, h, planeH);
            MemoryBarrier();
            if (sf->seq == s1) return true;
        }
        return true; // a rare torn frame beats a stall
    }
};

// ------------------------------------------------------------------ stream

class Stream : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                                   ChainInterfaces<IMFMediaStream2, IMFMediaStream, IMFMediaEventGenerator>,
                                   IKsControl> {
    std::mutex m;
    std::condition_variable cv;
    ComPtr<IMFMediaEventQueue> q;
    ComPtr<IMFMediaSource> source;
    ComPtr<IMFStreamDescriptor> sd;
    ComPtr<IMFVideoSampleAllocatorEx> alloc;
    MF_STREAM_STATE state = MF_STREAM_STATE_STOPPED;
    std::deque<ComPtr<IUnknown>> tokens;
    std::thread worker;
    bool quit = false;
    UINT w = 1920, h = 1080;
    LONGLONG interval = 333333; // 100 ns units
    FrameReader reader;

public:
    ComPtr<IMFAttributes> attrs;

    ~Stream() { StopWorker(); }

    HRESULT Init(IMFMediaSource* src, IMFStreamDescriptor* desc) {
        source = src;
        sd = desc;
        HRESULT hr = MFCreateEventQueue(&q);
        if (SUCCEEDED(hr)) hr = MFCreateAttributes(&attrs, 4);
        if (SUCCEEDED(hr)) hr = attrs->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
        if (SUCCEEDED(hr)) hr = attrs->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
        if (SUCCEEDED(hr)) hr = attrs->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
        if (SUCCEEDED(hr)) hr = attrs->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
        return hr;
    }

    HRESULT Start(IMFMediaType* mt) {
        std::lock_guard<std::mutex> l(m);
        if (quit) return MF_E_SHUTDOWN;
        UINT32 num = 30, den = 1;
        MFGetAttributeSize(mt, MF_MT_FRAME_SIZE, &w, &h);
        MFGetAttributeRatio(mt, MF_MT_FRAME_RATE, &num, &den);
        interval = num ? 10000000LL * den / num : 333333;
        if (alloc) alloc->UninitializeSampleAllocator();
        alloc.Reset();
        HRESULT hr = MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&alloc));
        if (SUCCEEDED(hr)) hr = alloc->InitializeSampleAllocator(8, mt);
        if (FAILED(hr)) return hr;
        tokens.clear();
        state = MF_STREAM_STATE_RUNNING;
        if (!worker.joinable()) worker = std::thread([this] { Run(); });
        cv.notify_all();
        return q->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
    }

    HRESULT Stop() {
        std::lock_guard<std::mutex> l(m);
        if (quit) return MF_E_SHUTDOWN;
        state = MF_STREAM_STATE_STOPPED;
        tokens.clear();
        return q->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
    }

    void Shutdown() {
        {
            std::lock_guard<std::mutex> l(m);
            if (q) q->Shutdown();
        }
        StopWorker();
        std::lock_guard<std::mutex> l(m);
        if (alloc) alloc->UninitializeSampleAllocator();
        alloc.Reset();
        source.Reset();
    }

private:
    void StopWorker() {
        {
            std::lock_guard<std::mutex> l(m);
            quit = true;
            state = MF_STREAM_STATE_STOPPED;
        }
        cv.notify_all();
        if (worker.joinable() && worker.get_id() != std::this_thread::get_id()) worker.join();
    }

    HRESULT Fill(IMFSample* s, UINT fw, UINT fh) {
        ComPtr<IMFMediaBuffer> b;
        HRESULT hr = s->GetBufferByIndex(0, &b);
        if (FAILED(hr)) return hr;
        ComPtr<IMF2DBuffer2> b2;
        if (SUCCEEDED(b.As(&b2))) {
            BYTE *scan0, *start;
            LONG pitch;
            DWORD len;
            hr = b2->Lock2DSize(MF2DBuffer_LockFlags_Write, &scan0, &pitch, &start, &len);
            if (FAILED(hr)) return hr;
            UINT planeH = pitch > 0 ? (UINT)(len / ((DWORD)pitch * 3 / 2)) : fh;
            if (planeH < fh) planeH = fh;
            if (!reader.Read(scan0, pitch, fw, fh, planeH)) FillBlack(scan0, pitch, fw, fh, planeH);
            b2->Unlock2D();
        } else {
            BYTE* p;
            DWORD max;
            hr = b->Lock(&p, &max, nullptr);
            if (FAILED(hr)) return hr;
            if (!reader.Read(p, fw, fw, fh, fh)) FillBlack(p, fw, fw, fh, fh);
            b->Unlock();
            b->SetCurrentLength(fw * fh * 3 / 2);
        }
        return S_OK;
    }

    // Answers RequestSample tokens at the negotiated frame rate.
    void Run() {
        LONGLONG next = 0;
        std::unique_lock<std::mutex> l(m);
        for (;;) {
            cv.wait(l, [&] { return quit || (state == MF_STREAM_STATE_RUNNING && !tokens.empty()); });
            if (quit) return;
            ComPtr<IUnknown> token = tokens.front();
            tokens.pop_front();
            ComPtr<IMFVideoSampleAllocatorEx> a = alloc;
            UINT fw = w, fh = h;
            LONGLONG iv = interval;
            l.unlock();

            LONGLONG now = MFGetSystemTime();
            if (next > now) {
                std::this_thread::sleep_for(std::chrono::microseconds((next - now) / 10));
                now = MFGetSystemTime();
            }
            next = (next > now - iv ? next : now) + iv;

            ComPtr<IMFSample> s;
            HRESULT hr = a ? a->AllocateSample(&s) : MF_E_NOT_INITIALIZED;
            if (SUCCEEDED(hr)) hr = Fill(s.Get(), fw, fh);
            if (SUCCEEDED(hr)) {
                s->SetSampleTime(now);
                s->SetSampleDuration(iv);
                if (token) s->SetUnknown(MFSampleExtension_Token, token.Get());
            }

            l.lock();
            if (quit) return;
            if (state != MF_STREAM_STATE_RUNNING) continue;
            if (hr == MF_E_SAMPLEALLOCATOR_EMPTY) {
                // every sample is still out with the app; retry shortly
                tokens.push_front(token);
                l.unlock();
                Sleep(2);
                l.lock();
                continue;
            }
            if (SUCCEEDED(hr)) q->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, s.Get());
            else q->QueueEventParamVar(MEError, GUID_NULL, hr, nullptr);
        }
    }

public:
    // IMFMediaEventGenerator
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* st) override { return q->BeginGetEvent(cb, st); }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** e) override { return q->EndGetEvent(r, e); }
    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** e) override { return q->GetEvent(flags, e); }
    STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT hr, const PROPVARIANT* v) override {
        return q->QueueEventParamVar(t, g, hr, v);
    }

    // IMFMediaStream
    STDMETHODIMP GetMediaSource(IMFMediaSource** out) override {
        std::lock_guard<std::mutex> l(m);
        if (!source) return MF_E_SHUTDOWN;
        return source.CopyTo(out);
    }
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** out) override {
        std::lock_guard<std::mutex> l(m);
        if (quit) return MF_E_SHUTDOWN;
        return sd.CopyTo(out);
    }
    STDMETHODIMP RequestSample(IUnknown* token) override {
        std::lock_guard<std::mutex> l(m);
        if (quit) return MF_E_SHUTDOWN;
        if (state != MF_STREAM_STATE_RUNNING) return MF_E_MEDIA_SOURCE_WRONGSTATE;
        tokens.push_back(token);
        cv.notify_one();
        return S_OK;
    }

    // IMFMediaStream2
    STDMETHODIMP SetStreamState(MF_STREAM_STATE s) override {
        std::lock_guard<std::mutex> l(m);
        if (quit) return MF_E_SHUTDOWN;
        state = s;
        cv.notify_all();
        return S_OK;
    }
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* s) override {
        std::lock_guard<std::mutex> l(m);
        *s = state;
        return S_OK;
    }

    // IKsControl: no custom properties
    STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
};

// ------------------------------------------------------------------ source

static HRESULT MakeType(UINT w, UINT h, UINT fps, IMFMediaType** out) {
    ComPtr<IMFMediaType> t;
    HRESULT hr = MFCreateMediaType(&t);
    if (FAILED(hr)) return hr;
    t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, w, h);
    MFSetAttributeRatio(t.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(t.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    t->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    t->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
    t->SetUINT32(MF_MT_DEFAULT_STRIDE, w);
    t->SetUINT32(MF_MT_SAMPLE_SIZE, w * h * 3 / 2);
    *out = t.Detach();
    return S_OK;
}

class Source : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                                   ChainInterfaces<IMFMediaSourceEx, IMFMediaSource, IMFMediaEventGenerator>,
                                   IMFGetService, IKsControl, IMFSampleAllocatorControl> {
    std::mutex m;
    ComPtr<IMFMediaEventQueue> q;
    ComPtr<IMFPresentationDescriptor> pd;
    ComPtr<Stream> stream;
    ComPtr<IMFAttributes> attrs;
    bool shut = false, started = false, mfStarted = false;

public:
    ~Source() { if (mfStarted) MFShutdown(); }

    HRESULT Initialize(IMFAttributes* activatorAttrs) {
        HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
        if (FAILED(hr)) return hr;
        mfStarted = true;
        hr = MFCreateAttributes(&attrs, 4);
        if (SUCCEEDED(hr) && activatorAttrs) hr = activatorAttrs->CopyAllItems(attrs.Get());
        if (SUCCEEDED(hr)) hr = MFCreateEventQueue(&q);
        if (FAILED(hr)) return hr;

        // Every size the phone can send; the app picks one and we scale to it.
        static const UINT modes[][3] = {{1920, 1080, 30}, {1280, 720, 30}, {3840, 2160, 30}, {2560, 1440, 30},
                                        {1920, 1080, 60}, {1280, 720, 60}, {640, 360, 30}};
        std::vector<ComPtr<IMFMediaType>> types;
        std::vector<IMFMediaType*> raw;
        for (auto& md : modes) {
            ComPtr<IMFMediaType> t;
            hr = MakeType(md[0], md[1], md[2], &t);
            if (FAILED(hr)) return hr;
            raw.push_back(t.Get());
            types.push_back(t);
        }
        ComPtr<IMFStreamDescriptor> sd;
        hr = MFCreateStreamDescriptor(0, (DWORD)raw.size(), raw.data(), &sd);
        if (FAILED(hr)) return hr;
        ComPtr<IMFMediaTypeHandler> handler;
        sd->GetMediaTypeHandler(&handler);
        handler->SetCurrentMediaType(raw[0]);
        sd->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
        sd->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
        sd->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
        sd->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);

        IMFStreamDescriptor* sds[] = {sd.Get()};
        hr = MFCreatePresentationDescriptor(1, sds, &pd);
        if (FAILED(hr)) return hr;
        pd->SelectStream(0);

        stream = Make<Stream>();
        if (!stream) return E_OUTOFMEMORY;
        return stream->Init(this, sd.Get());
    }

    // IMFMediaEventGenerator
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* cb, IUnknown* st) override {
        std::lock_guard<std::mutex> l(m);
        return shut ? MF_E_SHUTDOWN : q->BeginGetEvent(cb, st);
    }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* r, IMFMediaEvent** e) override {
        std::lock_guard<std::mutex> l(m);
        return shut ? MF_E_SHUTDOWN : q->EndGetEvent(r, e);
    }
    STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** e) override {
        ComPtr<IMFMediaEventQueue> qq;
        {
            std::lock_guard<std::mutex> l(m);
            if (shut) return MF_E_SHUTDOWN;
            qq = q;
        }
        return qq->GetEvent(flags, e); // may block: don't hold the lock
    }
    STDMETHODIMP QueueEvent(MediaEventType t, REFGUID g, HRESULT hr, const PROPVARIANT* v) override {
        std::lock_guard<std::mutex> l(m);
        return shut ? MF_E_SHUTDOWN : q->QueueEventParamVar(t, g, hr, v);
    }

    // IMFMediaSource
    STDMETHODIMP GetCharacteristics(DWORD* c) override {
        *c = MFMEDIASOURCE_IS_LIVE;
        return S_OK;
    }
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** out) override {
        std::lock_guard<std::mutex> l(m);
        return shut ? MF_E_SHUTDOWN : pd->Clone(out);
    }
    STDMETHODIMP Start(IMFPresentationDescriptor* p, const GUID* fmt, const PROPVARIANT* pos) override {
        if (!p || !pos) return E_INVALIDARG;
        if (fmt && *fmt != GUID_NULL) return MF_E_UNSUPPORTED_TIME_FORMAT;
        std::lock_guard<std::mutex> l(m);
        if (shut) return MF_E_SHUTDOWN;
        DWORD n = 0;
        HRESULT hr = p->GetStreamDescriptorCount(&n);
        for (DWORD i = 0; SUCCEEDED(hr) && i < n; i++) {
            BOOL selected;
            ComPtr<IMFStreamDescriptor> sd;
            hr = p->GetStreamDescriptorByIndex(i, &selected, &sd);
            if (FAILED(hr)) break;
            DWORD id;
            sd->GetStreamIdentifier(&id);
            if (id != 0) continue;
            if (selected) {
                pd->SelectStream(0);
                ComPtr<IMFMediaTypeHandler> h;
                ComPtr<IMFMediaType> mt;
                hr = sd->GetMediaTypeHandler(&h);
                if (SUCCEEDED(hr)) hr = h->GetCurrentMediaType(&mt);
                if (SUCCEEDED(hr)) hr = q->QueueEventParamUnk(started ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK,
                                                              static_cast<IMFMediaStream*>(stream.Get()));
                if (SUCCEEDED(hr)) hr = stream->Start(mt.Get());
                started = true;
            } else {
                pd->DeselectStream(0);
                stream->Stop();
            }
        }
        PROPVARIANT t;
        PropVariantInit(&t);
        t.vt = VT_I8;
        t.hVal.QuadPart = MFGetSystemTime();
        q->QueueEventParamVar(MESourceStarted, GUID_NULL, hr, &t);
        return hr;
    }
    STDMETHODIMP Stop() override {
        std::lock_guard<std::mutex> l(m);
        if (shut) return MF_E_SHUTDOWN;
        stream->Stop();
        return q->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
    }
    STDMETHODIMP Pause() override { return MF_E_INVALID_STATE_TRANSITION; }
    STDMETHODIMP Shutdown() override {
        ComPtr<Stream> s;
        {
            std::lock_guard<std::mutex> l(m);
            if (shut) return MF_E_SHUTDOWN;
            shut = true;
            q->Shutdown();
            s = stream;
            stream.Reset();
        }
        if (s) s->Shutdown();
        return S_OK;
    }

    // IMFMediaSourceEx
    STDMETHODIMP GetSourceAttributes(IMFAttributes** a) override { return attrs.CopyTo(a); }
    STDMETHODIMP GetStreamAttributes(DWORD id, IMFAttributes** a) override {
        std::lock_guard<std::mutex> l(m);
        if (shut) return MF_E_SHUTDOWN;
        if (id != 0) return MF_E_INVALIDSTREAMNUMBER;
        return stream->attrs.CopyTo(a);
    }
    STDMETHODIMP SetD3DManager(IUnknown*) override { return S_OK; } // system-memory samples only

    // IMFGetService
    STDMETHODIMP GetService(REFGUID, REFIID, LPVOID*) override { return MF_E_UNSUPPORTED_SERVICE; }

    // IKsControl
    STDMETHODIMP KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
    STDMETHODIMP KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }
    STDMETHODIMP KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG*) override { return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND); }

    // IMFSampleAllocatorControl: we bring our own allocator
    STDMETHODIMP SetDefaultAllocator(DWORD, IUnknown*) override { return S_OK; }
    STDMETHODIMP GetAllocatorUsage(DWORD out, DWORD* in, MFSampleAllocatorUsage* usage) override {
        *in = out;
        *usage = MFSampleAllocatorUsage_UsesCustomAllocator;
        return S_OK;
    }
};

// ------------------------------------------------------------------ activator + COM plumbing

#define FWD(name, params, args) STDMETHODIMP name params override { return a->name args; }

class Activator : public RuntimeClass<RuntimeClassFlags<ClassicCom>, ChainInterfaces<IMFActivate, IMFAttributes>> {
    ComPtr<IMFAttributes> a;
    ComPtr<Source> src;

public:
    HRESULT Init() { return MFCreateAttributes(&a, 4); }

    STDMETHODIMP ActivateObject(REFIID riid, void** ppv) override {
        if (!src) {
            auto s = Make<Source>();
            if (!s) return E_OUTOFMEMORY;
            HRESULT hr = s->Initialize(a.Get());
            if (FAILED(hr)) return hr;
            src = s;
        }
        return src->QueryInterface(riid, ppv);
    }
    STDMETHODIMP ShutdownObject() override {
        if (src) src->Shutdown();
        src.Reset();
        return S_OK;
    }
    STDMETHODIMP DetachObject() override {
        src.Reset();
        return S_OK;
    }

    FWD(GetItem, (REFGUID k, PROPVARIANT* v), (k, v))
    FWD(GetItemType, (REFGUID k, MF_ATTRIBUTE_TYPE* t), (k, t))
    FWD(CompareItem, (REFGUID k, REFPROPVARIANT v, BOOL* r), (k, v, r))
    FWD(Compare, (IMFAttributes* o, MF_ATTRIBUTES_MATCH_TYPE t, BOOL* r), (o, t, r))
    FWD(GetUINT32, (REFGUID k, UINT32* v), (k, v))
    FWD(GetUINT64, (REFGUID k, UINT64* v), (k, v))
    FWD(GetDouble, (REFGUID k, double* v), (k, v))
    FWD(GetGUID, (REFGUID k, GUID* v), (k, v))
    FWD(GetStringLength, (REFGUID k, UINT32* v), (k, v))
    FWD(GetString, (REFGUID k, LPWSTR v, UINT32 n, UINT32* l), (k, v, n, l))
    FWD(GetAllocatedString, (REFGUID k, LPWSTR* v, UINT32* l), (k, v, l))
    FWD(GetBlobSize, (REFGUID k, UINT32* v), (k, v))
    FWD(GetBlob, (REFGUID k, UINT8* v, UINT32 n, UINT32* l), (k, v, n, l))
    FWD(GetAllocatedBlob, (REFGUID k, UINT8** v, UINT32* l), (k, v, l))
    FWD(GetUnknown, (REFGUID k, REFIID r, LPVOID* v), (k, r, v))
    FWD(SetItem, (REFGUID k, REFPROPVARIANT v), (k, v))
    FWD(DeleteItem, (REFGUID k), (k))
    FWD(DeleteAllItems, (), ())
    FWD(SetUINT32, (REFGUID k, UINT32 v), (k, v))
    FWD(SetUINT64, (REFGUID k, UINT64 v), (k, v))
    FWD(SetDouble, (REFGUID k, double v), (k, v))
    FWD(SetGUID, (REFGUID k, REFGUID v), (k, v))
    FWD(SetString, (REFGUID k, LPCWSTR v), (k, v))
    FWD(SetBlob, (REFGUID k, const UINT8* v, UINT32 n), (k, v, n))
    FWD(SetUnknown, (REFGUID k, IUnknown* v), (k, v))
    FWD(LockStore, (), ())
    FWD(UnlockStore, (), ())
    FWD(GetCount, (UINT32* n), (n))
    FWD(GetItemByIndex, (UINT32 i, GUID* k, PROPVARIANT* v), (i, k, v))
    FWD(CopyAllItems, (IMFAttributes* d), (d))
};

class Factory : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IClassFactory> {
public:
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto act = Make<Activator>();
        if (!act) return E_OUTOFMEMORY;
        HRESULT hr = act->Init();
        return FAILED(hr) ? hr : act->QueryInterface(riid, ppv);
    }
    STDMETHODIMP LockServer(BOOL) override { return S_OK; }
};

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = h;
        DisableThreadLibraryCalls(h);
    }
    return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
    if (clsid != CLSID_openCam) return CLASS_E_CLASSNOTAVAILABLE;
    auto f = Make<Factory>();
    return f ? f->QueryInterface(riid, ppv) : E_OUTOFMEMORY;
}

// ponytail: never unloads; Frame Server keeps the DLL for its lifetime anyway.
STDAPI DllCanUnloadNow() { return S_FALSE; }

#define CLSID_KEY L"Software\\Classes\\CLSID\\" OPENCAM_CLSID_STR

STDAPI DllRegisterServer() {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(g_module, path, MAX_PATH);
    HKEY k;
    LSTATUS err = RegCreateKeyExW(HKEY_LOCAL_MACHINE, CLSID_KEY L"\\InprocServer32", 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr);
    if (err) return HRESULT_FROM_WIN32(err);
    static const wchar_t model[] = L"Both";
    RegSetValueExW(k, nullptr, 0, REG_SZ, (const BYTE*)path, (DWORD)((wcslen(path) + 1) * sizeof(wchar_t)));
    RegSetValueExW(k, L"ThreadingModel", 0, REG_SZ, (const BYTE*)model, sizeof(model));
    RegCloseKey(k);
    return S_OK;
}

STDAPI DllUnregisterServer() {
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, CLSID_KEY);
    return S_OK;
}
