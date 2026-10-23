//! NVIDIA readings through NVML (nvml.dll, installed with the NVIDIA driver).
use super::{round, windows::Adapter, VendorReadings};
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};
use std::time::{Duration, Instant};

/// After NVML fails to start (no driver yet), try again this often, so installing the driver works
/// without restarting Open Dock.
const RETRY_EVERY: Duration = Duration::from_secs(60);

pub(super) struct Nvidia {
    nvml: Option<Nvml>,
    failed_at: Option<Instant>,
}

impl Nvidia {
    pub(super) fn new() -> Self {
        Self {
            nvml: None,
            failed_at: None,
        }
    }

    /// Started on first use, not at launch: on a hybrid laptop this runs only once the GPU is awake.
    fn nvml(&mut self) -> Option<&Nvml> {
        if self.nvml.is_none() && self.failed_at.is_none_or(|at| at.elapsed() >= RETRY_EVERY) {
            // From System32 only (see windows::load_system_library); drivers since 2019 install it there.
            let path = super::windows::system32("nvml.dll");
            match path
                .is_absolute()
                .then(|| Nvml::builder().lib_path(path.as_os_str()).init())
            {
                Some(Ok(nvml)) => self.nvml = Some(nvml),
                _ => self.failed_at = Some(Instant::now()),
            }
        }
        self.nvml.as_ref()
    }

    pub(super) fn read(&mut self, adapter: &Adapter) -> Option<VendorReadings> {
        let nvml = self.nvml()?;
        // NVML's pci_device_id packs the device id above the vendor id.
        let wanted = (adapter.device_id << 16) | adapter.vendor_id;
        let device = (0..nvml.device_count().ok()?)
            .filter_map(|index| nvml.device_by_index(index).ok())
            .find(|device| {
                device.pci_info().is_ok_and(|pci| {
                    pci.pci_device_id == wanted
                        && pci
                            .pci_sub_system_id
                            .is_none_or(|subsys| adapter.subsys == 0 || subsys == adapter.subsys)
                })
            })?;
        let memory = device.memory_info().ok();
        Some(VendorReadings {
            temp: device
                .temperature(TemperatureSensor::Gpu)
                .ok()
                .map(|celsius| celsius as f32),
            power: device
                .power_usage()
                .ok()
                .map(|milliwatts| round(milliwatts as f32 / 1000.0)),
            power_limit: device
                .enforced_power_limit()
                .ok()
                .map(|milliwatts| (milliwatts as f32 / 1000.0).round()),
            fan: device.fan_speed(0).ok().map(|percent| percent as f32),
            load: device
                .utilization_rates()
                .ok()
                .map(|rates| rates.gpu as f32),
            mem_used: memory
                .as_ref()
                .map(|memory| round(memory.used as f32 / super::GB)),
            mem_total: memory
                .as_ref()
                .map(|memory| round(memory.total as f32 / super::GB)),
            ..VendorReadings::default()
        })
    }
}
