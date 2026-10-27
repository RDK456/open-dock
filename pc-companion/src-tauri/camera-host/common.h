#pragma once
// Shared between the virtual camera DLL (runs inside Windows Frame Server) and the tray app.
#include <windows.h>

// {5D0C4E71-2B8A-4F36-A1D9-6E3B7C90F482}
#define OPENCAM_CLSID_STR L"{5D0C4E71-2B8A-4F36-A1D9-6E3B7C90F482}"
static const GUID CLSID_openCam = {0x5d0c4e71, 0x2b8a, 0x4f36, {0xa1, 0xd9, 0x6e, 0x3b, 0x7c, 0x90, 0xf4, 0x82}};

// Created by the DLL (LocalService may create Global\ objects), opened by the tray app.
#define OPENCAM_MAP_NAME L"Global\\openDockCamFrame"

constexpr UINT MAX_W = 3840, MAX_H = 2160;
enum : UINT { FLAG_MIRROR = 1, FLAG_ROT180 = 2 };

// One NV12 frame (stride == width). Seqlock: writer makes seq odd while writing.
struct SharedFrame {
    volatile LONG seq;
    UINT width, height, flags;
    volatile LONGLONG consumerTick; // GetTickCount64() of the last frame an app pulled
    volatile LONGLONG frameTick;    // GetTickCount64() of the last frame the tray app wrote
    BYTE data[MAX_W * MAX_H * 3 / 2];
};
