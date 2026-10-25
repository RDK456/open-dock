//! Reads an app's icon through the Windows shell, in this process. Starting PowerShell for each icon cost half a
//! second or more, flashed a console window, and froze the app while it ran.

use std::ffi::{c_void, OsStr};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HBITMAP, HGDIOBJ, RGBQUAD,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
use windows::Win32::UI::Shell::{ILFree, SHGetFileInfoW, SHGetImageList, SHParseDisplayName, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_PIDL, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use super::icon_png;

/// The largest icon edge accepted, in pixels. Shell icons are 32 to 64.
const MAX_EDGE: i32 = 256;

/// A 1-bit bitmap's header is followed by a two-entry color table, which `GetDIBits` writes into.
#[repr(C)]
struct MaskInfo {
    header: BITMAPINFOHEADER,
    colors: [RGBQUAD; 2],
}

/// The icon the shell shows for `path`: an app's own icon, or for a shortcut the icon Explorer shows for it
/// (its chosen icon, else its target's), without the little arrow. PNG bytes.
pub(super) fn app_icon_png(path: &str, max_png: usize) -> Result<Vec<u8>, String> {
    // The shell wants COM on the calling thread. Joining one that is already set up differently is fine.
    let started = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let result = read_icon(path, max_png);
    if started {
        unsafe { CoUninitialize() };
    }
    result
}

fn read_icon(path: &str, max_png: usize) -> Result<Vec<u8>, String> {
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    let mut info = SHFILEINFOW::default();
    let size = size_of::<SHFILEINFOW>() as u32;
    let found = if path.starts_with(super::win_apps::SHELL_PREFIX) {
        // Not a file: the shell finds the app by its address, and the icon is asked for by that item's id.
        let mut item = std::ptr::null_mut();
        unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut item, 0, None) }.map_err(|error| error.to_string())?;
        let found = unsafe { SHGetFileInfoW(PCWSTR(item as *const u16), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), size, SHGFI_PIDL | SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SYSICONINDEX) };
        unsafe { ILFree(Some(item)) };
        found
    } else {
        unsafe { SHGetFileInfoW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), size, SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SYSICONINDEX) }
    };
    if found == 0 || info.hIcon.is_invalid() {
        return Err("Windows has no icon for that file".into());
    }
    let _ = unsafe { DestroyIcon(info.hIcon) };
    // The shell's own 32 px icon is small and blurs on a phone. Ask for its 256 px, then 48 px, version first;
    // the 32 px one below is the fallback when those are missing or too big to store.
    for shil in [SHIL_JUMBO, SHIL_EXTRALARGE] {
        if let Some(png) = sized_png(info.iIcon, shil).filter(|png| png.len() <= max_png) {
            return Ok(png);
        }
    }
    let large = unsafe { SHGetFileInfoW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), size, SHGFI_ICON | SHGFI_LARGEICON) };
    if large == 0 || info.hIcon.is_invalid() {
        return Err("Windows has no icon for that file".into());
    }
    let result = icon_pixels(info.hIcon);
    let _ = unsafe { DestroyIcon(info.hIcon) };
    let (width, height, rgba) = result?;
    icon_png::encode_png(width, height, &rgba)
}

/// The shell icon at `index` from one of its image lists (extra large 48 px, jumbo 256 px), as a PNG.
fn sized_png(index: i32, list_size: u32) -> Option<Vec<u8>> {
    let list: IImageList = unsafe { SHGetImageList(list_size as i32) }.ok()?;
    let icon = unsafe { list.GetIcon(index, ILD_TRANSPARENT.0 as u32) }.ok()?;
    let pixels = icon_pixels(icon);
    let _ = unsafe { DestroyIcon(icon) };
    let (width, height, rgba) = pixels.ok()?;
    icon_png::encode_png(width, height, &rgba).ok()
}

fn icon_pixels(icon: HICON) -> Result<(u32, u32, Vec<u8>), String> {
    let mut parts = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut parts) }.map_err(|error| error.to_string())?;
    let (color, mask) = (parts.hbmColor, parts.hbmMask);
    let result = read_bitmaps(color, mask);
    for bitmap in [color, mask] {
        if !bitmap.is_invalid() {
            let _ = unsafe { DeleteObject(bitmap.into()) };
        }
    }
    result
}

fn read_bitmaps(color: HBITMAP, mask: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    if color.is_invalid() {
        return Err("The icon is a plain black-and-white one".into());
    }
    let mut bitmap = BITMAP::default();
    let got = unsafe { GetObjectW(HGDIOBJ::from(color), size_of::<BITMAP>() as i32, Some(&mut bitmap as *mut BITMAP as *mut c_void)) };
    if got == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 || bitmap.bmWidth > MAX_EDGE || bitmap.bmHeight > MAX_EDGE {
        return Err("The icon has an unexpected size".into());
    }
    let (width, height) = (bitmap.bmWidth, bitmap.bmHeight);
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        return Err("Could not read the icon".into());
    }
    let result = (|| {
        // Color: 32 bits per pixel, top row first.
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = unsafe { GetDIBits(dc, color, 0, height as u32, Some(pixels.as_mut_ptr() as *mut c_void), &mut header, DIB_RGB_COLORS) };
        if lines != height {
            return Err("Could not read the icon's colors".to_owned());
        }
        // Old icons carry no alpha; their see-through areas are in the mask.
        let needs_mask = !pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
        let mut mask_bits = vec![0u8; (width as usize).div_ceil(32) * 4 * height as usize];
        let mut have_mask = false;
        if needs_mask && !mask.is_invalid() {
            let mut info = MaskInfo { header: BITMAPINFOHEADER::default(), colors: [RGBQUAD::default(); 2] };
            info.header = BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 1, ..Default::default() };
            let lines = unsafe { GetDIBits(dc, mask, 0, height as u32, Some(mask_bits.as_mut_ptr() as *mut c_void), &mut info as *mut MaskInfo as *mut BITMAPINFO, DIB_RGB_COLORS) };
            have_mask = lines == height;
        }
        let rgba = icon_png::bgra_to_rgba(width as usize, height as usize, &pixels, have_mask.then_some(mask_bits.as_slice()))?;
        Ok((width as u32, height as u32, rgba))
    })();
    let _ = unsafe { DeleteDC(dc) };
    result
}
