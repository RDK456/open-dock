//! The real CPU package temperature on Intel and AMD Ryzen, read through PawnIO
//! (pawnio.eu), the signed driver LibreHardwareMonitor uses. Windows gives user programs no other way.
//! It needs the PawnIO driver installed and Open Dock running as administrator; otherwise `open`
//! returns None. We talk to the driver directly (its setup ships no PawnIOLib.dll); the protocol
//! follows PawnIO/include/pawnio_um.h and PawnIOLib.cpp.
//! IntelMSR.bin and AMDFamily17.bin are signed modules from PawnIO.Modules 0.2.11 (LGPL-2.1).
use std::{
    fs::{File, OpenOptions},
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::Command,
};
use windows::Win32::{Foundation::HANDLE, System::IO::DeviceIoControl};

const INTEL_MSR: &[u8] = include_bytes!("IntelMSR.bin");
const AMD_FAMILY17: &[u8] = include_bytes!("AMDFamily17.bin");
const DEVICE: &str = r"\\.\GLOBALROOT\Device\PawnIO";
// CTL_CODE(41394, 0x821 / 0x841, METHOD_BUFFERED, FILE_ANY_ACCESS)
const IOCTL_LOAD_BINARY: u32 = 0xA1B2_2084;
const IOCTL_EXECUTE_FN: u32 = 0xA1B2_2104;
const IA32_TEMPERATURE_TARGET: u64 = 0x1a2;
const IA32_PACKAGE_THERM_STATUS: u64 = 0x1b1;

// AMD SMN (System Management Network) registers & masks
const AMD_F17H_M01H_THM_TCON_CUR_TMP: u32 = 0x00059800;
const AMD_F17H_TEMP_RANGE_SEL_MASK: u32 = 0x80000;
const AMD_F17H_TEMP_TJ_SEL_MASK: u32 = 0x30000;

#[derive(Clone, Copy, Debug, PartialEq)]
enum CpuVendor {
    Intel,
    Amd,
    Other,
}

pub(super) struct PawnIo {
    device: File,
    vendor: CpuVendor,
    /// TjMax: on Intel, the CPU reports its temperature as degrees below this.
    tj_max: f32,
}

fn cpu_vendor() -> CpuVendor {
    let id = std::arch::x86_64::__cpuid(0);
    let vendor = [id.ebx, id.edx, id.ecx].map(u32::to_le_bytes).concat();
    if vendor == b"GenuineIntel" {
        CpuVendor::Intel
    } else if vendor == b"AuthenticAMD" {
        CpuVendor::Amd
    } else {
        CpuVendor::Other
    }
}

/// Each step of opening PawnIO goes to %APPDATA%\app.opendock.pc\pawnio.log, so a missing CPU
/// temperature can be traced to the driver, admin rights or the module.
fn note(step: &str) {
    use std::io::Write;
    let Some(dir) = std::env::var_os("APPDATA") else { return };
    let path = std::path::Path::new(&dir).join("app.opendock.pc").join("pawnio.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{:?} {step}", std::time::SystemTime::now());
    }
}

fn open_device() -> Option<File> {
    let open = || OpenOptions::new().read(true).write(true).open(DEVICE).map_err(|error| note(&format!("open {DEVICE}: {error}"))).ok();
    open().or_else(|| {
        // PawnIO installs as a demand-start driver; starting it needs admin, like reading MSRs does.
        let started = Command::new("sc.exe").args(["start", "PawnIO"]).creation_flags(0x0800_0000).output();
        note(&format!("sc start PawnIO: {:?}", started.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())));
        open()
    })
}

impl PawnIo {
    pub(super) fn open() -> Option<Self> {
        let vendor = cpu_vendor();
        if vendor == CpuVendor::Other {
            note("unsupported CPU vendor (neither Intel nor AMD)");
            return None;
        }
        let device = open_device()?;
        let mut pawn = Self {
            device,
            vendor,
            tj_max: 100.0,
        };

        match vendor {
            CpuVendor::Intel => {
                if pawn.ioctl(IOCTL_LOAD_BINARY, INTEL_MSR, &mut []).is_none() {
                    note(&format!("load IntelMSR module: {:?}", std::io::Error::last_os_error()));
                    return None;
                }
                let Some(target) = pawn.read_msr(IA32_TEMPERATURE_TARGET).map(|value| (value >> 16) & 0xff) else {
                    note(&format!("read TjMax MSR: {:?}", std::io::Error::last_os_error()));
                    return None;
                };
                note(&format!("ready (Intel), TjMax {target}"));
                if target > 0 {
                    pawn.tj_max = target as f32;
                }
            }
            CpuVendor::Amd => {
                if pawn.ioctl(IOCTL_LOAD_BINARY, AMD_FAMILY17, &mut []).is_none() {
                    note(&format!("load AMDFamily17 module: {:?}", std::io::Error::last_os_error()));
                    return None;
                }
                note("ready (AMD Ryzen)");
            }
            CpuVendor::Other => unreachable!(),
        }

        Some(pawn)
    }

    fn ioctl(&self, code: u32, input: &[u8], output: &mut [u64]) -> Option<usize> {
        let mut written = 0u32;
        // SAFETY: both buffers outlive the synchronous call and their lengths are passed with them.
        unsafe {
            DeviceIoControl(
                HANDLE(self.device.as_raw_handle()),
                code,
                Some(input.as_ptr().cast()),
                input.len() as u32,
                (!output.is_empty()).then_some(output.as_mut_ptr().cast()),
                size_of_val(output) as u32,
                Some(&mut written),
                None,
            )
        }
        .ok()?;
        Some(written as usize / 8)
    }

    fn read_msr(&self, msr: u64) -> Option<u64> {
        // The function name, zero-padded to 32 bytes, then the u64 arguments.
        let mut input = [0u8; 40];
        input[..14].copy_from_slice(b"ioctl_read_msr");
        input[32..].copy_from_slice(&msr.to_le_bytes());
        let mut out = [0u64];
        (self.ioctl(IOCTL_EXECUTE_FN, &input, &mut out)? == 1).then_some(out[0])
    }

    fn read_smn(&self, register: u32) -> Option<u32> {
        let mut input = [0u8; 40];
        input[..14].copy_from_slice(b"ioctl_read_smn");
        input[32..40].copy_from_slice(&(register as u64).to_le_bytes());
        let mut out = [0u64];
        (self.ioctl(IOCTL_EXECUTE_FN, &input, &mut out)? == 1).then_some(out[0] as u32)
    }

    pub(super) fn package_celsius(&self) -> Option<f32> {
        match self.vendor {
            CpuVendor::Intel => package_celsius(self.read_msr(IA32_PACKAGE_THERM_STATUS)?, self.tj_max),
            CpuVendor::Amd => {
                let raw = self.read_smn(AMD_F17H_M01H_THM_TCON_CUR_TMP)?;
                let temp_offset_flag = (raw & AMD_F17H_TEMP_RANGE_SEL_MASK) != 0
                    || (raw & AMD_F17H_TEMP_TJ_SEL_MASK) == AMD_F17H_TEMP_TJ_SEL_MASK;
                let mut temp = ((raw >> 21) as f32) * 0.125;
                if temp_offset_flag {
                    temp -= 49.0;
                }
                (0.0..=125.0).contains(&temp).then_some((temp * 10.0).round() / 10.0)
            }
            CpuVendor::Other => None,
        }
    }
}

/// IA32_PACKAGE_THERM_STATUS bits 22:16 hold how many degrees below TjMax the package is.
fn package_celsius(status: u64, tj_max: f32) -> Option<f32> {
    (status != 0).then(|| tj_max - ((status >> 16) & 0x7f) as f32)
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_temperature_counts_down_from_tj_max() {
        assert_eq!(super::package_celsius(0x8836_0000, 100.0), Some(46.0));
        assert_eq!(super::package_celsius(0, 100.0), None);
    }
}
