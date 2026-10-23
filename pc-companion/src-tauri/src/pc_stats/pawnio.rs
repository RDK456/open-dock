//! The real CPU package temperature on Intel, read from the CPU's thermal MSRs through PawnIO
//! (pawnio.eu), the signed driver LibreHardwareMonitor uses. Windows gives user programs no other way.
//! It needs PawnIO installed and Open Dock running as administrator; otherwise `open` returns None.
//! IntelMSR.bin is the signed IntelMSR module from PawnIO.Modules 0.2.11 (LGPL-2.1).
use libloading::Library;
use std::{ffi::c_void, path::PathBuf};

const INTEL_MSR: &[u8] = include_bytes!("IntelMSR.bin");
const IA32_TEMPERATURE_TARGET: u64 = 0x1a2;
const IA32_PACKAGE_THERM_STATUS: u64 = 0x1b1;

type Handle = *mut c_void;
type Open = unsafe extern "system" fn(*mut Handle) -> i32;
type Load = unsafe extern "system" fn(Handle, *const u8, usize) -> i32;
type Execute =
    unsafe extern "system" fn(Handle, *const u8, *const u64, usize, *mut u64, usize, *mut usize) -> i32;
type Close = unsafe extern "system" fn(Handle) -> i32;

pub(super) struct PawnIo {
    handle: Handle,
    execute: Execute,
    close: Close,
    /// TjMax: the CPU reports its temperature as degrees below this.
    tj_max: f32,
    _library: Library,
}

// The handle is only used from the stats thread that owns the Sensors.
unsafe impl Send for PawnIo {}

fn is_intel() -> bool {
    let id = std::arch::x86_64::__cpuid(0);
    [id.ebx, id.edx, id.ecx].map(u32::to_le_bytes).concat() == b"GenuineIntel"
}

impl PawnIo {
    pub(super) fn open() -> Option<Self> {
        if !is_intel() {
            return None;
        }
        let dir = std::env::var_os("ProgramFiles").map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
        // SAFETY: PawnIOLib.dll comes from the signed PawnIO install; the signatures follow PawnIOLib.h.
        unsafe {
            let library = Library::new(dir.join(r"PawnIO\PawnIOLib.dll")).ok()?;
            let open = *library.get::<Open>(b"pawnio_open\0").ok()?;
            let load = *library.get::<Load>(b"pawnio_load\0").ok()?;
            let execute = *library.get::<Execute>(b"pawnio_execute\0").ok()?;
            let close = *library.get::<Close>(b"pawnio_close\0").ok()?;
            let mut handle: Handle = std::ptr::null_mut();
            if open(&mut handle) < 0 {
                return None;
            }
            let mut pawn = Self { handle, execute, close, tj_max: 100.0, _library: library };
            if load(handle, INTEL_MSR.as_ptr(), INTEL_MSR.len()) < 0 {
                return None;
            }
            let target = (pawn.read_msr(IA32_TEMPERATURE_TARGET)? >> 16) & 0xff;
            if target > 0 {
                pawn.tj_max = target as f32;
            }
            Some(pawn)
        }
    }

    fn read_msr(&self, msr: u64) -> Option<u64> {
        let (mut out, mut written) = (0u64, 0usize);
        // SAFETY: one u64 in, one u64 out, as IntelMSR's ioctl_read_msr declares.
        let status = unsafe { (self.execute)(self.handle, b"ioctl_read_msr\0".as_ptr(), &msr, 1, &mut out, 1, &mut written) };
        (status >= 0 && written == 1).then_some(out)
    }

    pub(super) fn package_celsius(&self) -> Option<f32> {
        package_celsius(self.read_msr(IA32_PACKAGE_THERM_STATUS)?, self.tj_max)
    }
}

/// IA32_PACKAGE_THERM_STATUS bits 22:16 hold how many degrees below TjMax the package is.
fn package_celsius(status: u64, tj_max: f32) -> Option<f32> {
    (status != 0).then(|| tj_max - ((status >> 16) & 0x7f) as f32)
}

impl Drop for PawnIo {
    fn drop(&mut self) {
        // SAFETY: the handle came from pawnio_open and is closed once.
        unsafe { (self.close)(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_temperature_counts_down_from_tj_max() {
        assert_eq!(super::package_celsius(0x8836_0000, 100.0), Some(46.0));
        assert_eq!(super::package_celsius(0, 100.0), None);
    }
}
