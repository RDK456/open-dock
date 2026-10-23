//! Windows GPU detection and sensors.
//!
//! Detect: DXGI lists GPUs with working drivers; the display device list finds GPUs without one.
//! Readings, per GPU, highest priority first (each fills only what's still empty):
//!   load    GPU Engine counter (what Task Manager shows), else D3DKMT node statistics, else vendor
//!   memory  GPU Adapter Memory counter, else vendor
//!   temp, hotspot, power, fan   vendor library (NVML / ADLX / ADL / IGCL), else D3DKMT perf data
//! CPU temperature: the ACPI Thermal Zone counter, which needs no admin rights. It's approximate,
//! and ignored when it never moves (see parse::StuckSensor).
use super::{
    amd, fill, intel, nvidia, parse, round, CpuTemp, GpuKind, GpuState, GpuStats, MemKind, Vendor,
    GB,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR},
    Wdk::Graphics::Direct3D::*,
    Win32::{
        Devices::DeviceAndDriverInstallation::*, Foundation::LUID, Graphics::Dxgi::*,
        System::Performance::*,
    },
};

/// GPUs are listed again this often, so installing a driver or plugging in an eGPU needs no restart.
const DETECT_EVERY: Duration = Duration::from_secs(30);
/// A hybrid laptop's discrete GPU counts as awake this long after it last showed load.
const AWAKE_FOR: Duration = Duration::from_secs(15);

/// One GPU with a working driver, as DXGI reports it.
pub(super) struct Adapter {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) vendor: Vendor,
    pub(super) vendor_id: u32,
    pub(super) device_id: u32,
    pub(super) subsys: u32,
    pub(super) luid: LUID,
    luid_key: String,
    dedicated: u64,
    shared: u64,
    kind: GpuKind,
    /// Kernel adapter handle for D3DKMT perf data.
    kmt: Option<u32>,
    /// D3DKMT node running times, for load when the GPU Engine counter is missing.
    nodes: Option<NodeClock>,
}

impl Drop for Adapter {
    fn drop(&mut self) {
        if let Some(handle) = self.kmt {
            let _ = unsafe { D3DKMTCloseAdapter(&D3DKMT_CLOSEADAPTER { hAdapter: handle }) };
        }
    }
}

struct NodeClock {
    running: Vec<i64>,
    at: Instant,
}

pub(super) struct Sensors {
    adapters: Vec<Adapter>,
    /// GPUs in the PC without a driver.
    orphans: Vec<GpuStats>,
    detected: Option<Instant>,
    /// When each hybrid discrete GPU (by id) last showed load.
    active: HashMap<String, Instant>,
    counters: Option<Counters>,
    thermal: parse::StuckSensor,
    started: Instant,
    nvidia: nvidia::Nvidia,
    amd: amd::Amd,
    intel: intel::Intel,
    raw: serde_json::Value,
}

impl Sensors {
    pub(super) fn new() -> Self {
        Self {
            adapters: Vec::new(),
            orphans: Vec::new(),
            detected: None,
            active: HashMap::new(),
            counters: Counters::open(),
            thermal: parse::StuckSensor::new(),
            started: Instant::now(),
            nvidia: nvidia::Nvidia::new(),
            amd: amd::Amd::new(),
            intel: intel::Intel::new(),
            raw: serde_json::Value::Null,
        }
    }

    /// Called first each tick: it also collects this tick's performance counters.
    pub(super) fn cpu_temp(&mut self, cpu_load: f32) -> Option<CpuTemp> {
        let counters = self.counters.as_ref()?;
        counters.collect();
        let (counter, tenths) = counters.thermal?;
        let raw = counters
            .values(counter)
            .into_iter()
            .map(|(_, value)| value)
            .fold(f64::NAN, f64::max);
        let kelvin = if tenths { raw / 10.0 } else { raw };
        let celsius = (kelvin - 273.15) as f32;
        if !(1.0..=125.0).contains(&celsius) {
            return None;
        }
        if self
            .thermal
            .observe(celsius, cpu_load, self.started.elapsed().as_secs_f64())
        {
            return None;
        }
        Some(CpuTemp {
            celsius,
            approx: true,
            source: "thermal-zone",
        })
    }

    pub(super) fn gpus(&mut self, _ram_total_gb: f32) -> Vec<GpuStats> {
        if self.detected.is_none_or(|at| at.elapsed() >= DETECT_EVERY) {
            self.detect();
        }
        let now = Instant::now();
        let (loads, dedicated, shared) = match &self.counters {
            Some(counters) => (
                counters.engine_loads(),
                counters.memory(counters.dedicated),
                counters.memory(counters.shared),
            ),
            None => Default::default(),
        };
        let hybrid = self
            .adapters
            .iter()
            .any(|adapter| adapter.kind == GpuKind::Integrated);
        let mut raw = Vec::new();
        let mut gpus = Vec::new();
        for adapter in &mut self.adapters {
            let integrated = adapter.kind == GpuKind::Integrated;
            let mut gpu = GpuStats {
                id: adapter.id.clone(),
                name: adapter.name.clone(),
                vendor: adapter.vendor,
                kind: adapter.kind,
                mem_kind: if integrated {
                    MemKind::Shared
                } else {
                    MemKind::Dedicated
                },
                ..GpuStats::default()
            };
            fill!(
                gpu,
                load,
                "gpu-engine-counter",
                loads.get(&adapter.luid_key).map(|load| round(*load))
            );
            if gpu.load.is_none() {
                fill!(
                    gpu,
                    load,
                    "d3dkmt-statistics",
                    node_load(adapter).map(round)
                );
            }
            let memory = if integrated { &shared } else { &dedicated };
            fill!(
                gpu,
                mem_used,
                "gpu-memory-counter",
                memory
                    .get(&adapter.luid_key)
                    .map(|bytes| round(*bytes as f32 / GB))
            );
            let total = if integrated {
                adapter.shared
            } else {
                adapter.dedicated
            };
            fill!(
                gpu,
                mem_total,
                "dxgi",
                (total > 0).then(|| round(total as f32 / GB))
            );

            if gpu.load.is_some_and(|load| load > 0.5) {
                self.active.insert(adapter.id.clone(), now);
            }
            // On a hybrid laptop the discrete GPU powers down when idle. Counters never wake it, but
            // vendor libraries and D3DKMT perf data can, so they're only asked while it's in use.
            let gated = hybrid && adapter.kind == GpuKind::Discrete;
            if gated
                && self
                    .active
                    .get(&adapter.id)
                    .is_none_or(|at| now.duration_since(*at) >= AWAKE_FOR)
            {
                gpu.state = GpuState::Sleeping;
                gpu.load.get_or_insert(0.0);
                gpus.push(gpu);
                continue;
            }

            let vendor = match adapter.vendor {
                Vendor::Nvidia => self.nvidia.read(adapter).map(|readings| ("nvml", readings)),
                Vendor::Amd => self.amd.read(adapter),
                Vendor::Intel => self.intel.read(adapter),
                _ => None,
            };
            if let Some((source, readings)) = vendor {
                gpu.fill_vendor(source, readings);
            }
            let perf = adapter.kmt.and_then(perf_data);
            if let Some(perf) = perf {
                // Temperature is in tenths of a degree, Power in tenths of a percent of the limit.
                // Zero means the driver doesn't report it.
                fill!(
                    gpu,
                    temp,
                    "d3dkmt",
                    (perf.Temperature > 0 && perf.Temperature < 1500)
                        .then(|| perf.Temperature as f32 / 10.0)
                );
                fill!(
                    gpu,
                    fan_rpm,
                    "d3dkmt",
                    (perf.FanRPM > 0).then_some(perf.FanRPM as f32)
                );
                fill!(
                    gpu,
                    power_percent,
                    "d3dkmt",
                    (perf.Power > 0 && perf.Power <= 1000).then(|| perf.Power as f32 / 10.0)
                );
            }
            raw.push(serde_json::json!({
                "id": adapter.id, "name": adapter.name, "vendorId": adapter.vendor_id, "deviceId": adapter.device_id,
                "subsys": adapter.subsys, "luid": adapter.luid_key, "dedicated": adapter.dedicated, "shared": adapter.shared,
                "kind": adapter.kind, "perf": perf.map(|p| [p.Temperature, p.FanRPM, p.Power]),
            }));
            gpus.push(gpu);
        }
        self.raw = serde_json::json!({ "adapters": raw, "orphans": self.orphans.len(), "loads": loads, "dedicated": dedicated, "shared": shared });
        gpus.extend(self.orphans.iter().cloned());
        gpus
    }

    pub(super) fn dump(&self) -> serde_json::Value {
        self.raw.clone()
    }

    fn detect(&mut self) {
        self.detected = Some(Instant::now());
        let mut adapters: Vec<Adapter> = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                self.adapters.clear();
                return;
            };
            for index in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(index) else {
                    break;
                };
                let Ok(desc) = adapter.GetDesc1() else {
                    continue;
                };
                // Skip WARP and the Microsoft Basic Render/Display adapters (vendor 1414).
                if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 || desc.VendorId == 0x1414
                {
                    continue;
                }
                let ordinal = adapters
                    .iter()
                    .filter(|a| {
                        (a.vendor_id, a.device_id, a.subsys)
                            == (desc.VendorId, desc.DeviceId, desc.SubSysId)
                    })
                    .count();
                let name_len = desc
                    .Description
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(desc.Description.len());
                let vendor = Vendor::from_pci(desc.VendorId);
                let kmt = open_kmt(desc.AdapterLuid);
                let kind = match kmt.and_then(adapter_type) {
                    Some(flags) if flags & HYBRID_INTEGRATED != 0 => GpuKind::Integrated,
                    Some(flags) if flags & HYBRID_DISCRETE != 0 => GpuKind::Discrete,
                    _ => parse::guess_kind(vendor, desc.DedicatedVideoMemory as u64),
                };
                adapters.push(Adapter {
                    id: parse::gpu_id(desc.VendorId, desc.DeviceId, desc.SubSysId, ordinal),
                    name: String::from_utf16_lossy(&desc.Description[..name_len])
                        .trim()
                        .to_owned(),
                    vendor,
                    vendor_id: desc.VendorId,
                    device_id: desc.DeviceId,
                    subsys: desc.SubSysId,
                    luid: desc.AdapterLuid,
                    luid_key: parse::luid_key(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
                    dedicated: desc.DedicatedVideoMemory as u64,
                    shared: desc.SharedSystemMemory as u64,
                    kind,
                    kmt,
                    nodes: None,
                });
            }
        }
        // A GPU vendor's card in the device list with no DXGI adapter has no working driver
        // (Windows shows it as "Microsoft Basic Display Adapter").
        let mut orphans: Vec<GpuStats> = Vec::new();
        for (vendor_id, device_id, subsys) in display_devices() {
            let vendor = Vendor::from_pci(vendor_id);
            let known = matches!(vendor, Vendor::Nvidia | Vendor::Amd | Vendor::Intel);
            let id = parse::gpu_id(vendor_id, device_id, subsys, 0);
            if !known
                || adapters
                    .iter()
                    .any(|a| a.vendor_id == vendor_id && a.device_id == device_id)
                || orphans.iter().any(|g| g.id == id)
            {
                continue;
            }
            orphans.push(GpuStats {
                id,
                name: format!("{} GPU", vendor.name()),
                vendor,
                kind: if vendor == Vendor::Nvidia {
                    GpuKind::Discrete
                } else {
                    GpuKind::Unknown
                },
                state: GpuState::NoDriver,
                ..GpuStats::default()
            });
        }
        self.adapters = adapters;
        self.orphans = orphans;
    }
}

// D3DKMT_ADAPTERTYPE bits (d3dkmthk.h): RenderSupported, DisplaySupported, SoftwareDevice,
// PostDevice, HybridDiscrete, HybridIntegrated, ...
const HYBRID_DISCRETE: u32 = 1 << 4;
const HYBRID_INTEGRATED: u32 = 1 << 5;

fn open_kmt(luid: LUID) -> Option<u32> {
    let mut open = D3DKMT_OPENADAPTERFROMLUID {
        AdapterLuid: luid,
        hAdapter: 0,
    };
    unsafe { D3DKMTOpenAdapterFromLuid(&mut open) }
        .is_ok()
        .then_some(open.hAdapter)
}

fn query_adapter<T: Default>(
    handle: u32,
    kind: KMTQUERYADAPTERINFOTYPE,
    mut value: T,
) -> Option<T> {
    let mut info = D3DKMT_QUERYADAPTERINFO {
        hAdapter: handle,
        Type: kind,
        pPrivateDriverData: &mut value as *mut T as *mut core::ffi::c_void,
        PrivateDriverDataSize: size_of::<T>() as u32,
    };
    unsafe { D3DKMTQueryAdapterInfo(&mut info) }
        .is_ok()
        .then_some(value)
}

fn adapter_type(handle: u32) -> Option<u32> {
    query_adapter(
        handle,
        KMTQAITYPE_ADAPTERTYPE,
        D3DKMT_ADAPTERTYPE::default(),
    )
    .map(|kind| unsafe { kind.Anonymous.Value })
}

/// Temperature, fan and power the way Task Manager reads them; WDDM 2.4+ drivers.
fn perf_data(handle: u32) -> Option<D3DKMT_ADAPTER_PERFDATA> {
    query_adapter(
        handle,
        KMTQAITYPE_ADAPTERPERFDATA,
        D3DKMT_ADAPTER_PERFDATA::default(),
    )
}

fn statistics(query: &mut D3DKMT_QUERYSTATISTICS) -> bool {
    unsafe { D3DKMTQueryStatistics(query) }.is_ok()
}

/// GPU load from how long each engine (node) ran since the last sample, for PCs whose GPU Engine
/// counter is missing or broken. Returns the busiest node's share, like Task Manager. The first
/// call only primes the clock.
fn node_load(adapter: &mut Adapter) -> Option<f32> {
    let mut query = D3DKMT_QUERYSTATISTICS {
        Type: D3DKMT_QUERYSTATISTICS_ADAPTER,
        AdapterLuid: adapter.luid,
        ..Default::default()
    };
    if adapter.nodes.is_none() && !statistics(&mut query) {
        return None;
    }
    let count = match &adapter.nodes {
        Some(clock) => clock.running.len() as u32,
        None => unsafe { query.QueryResult.AdapterInformation.NodeCount },
    };
    let mut running = Vec::with_capacity(count as usize);
    for node in 0..count.min(64) {
        let mut query = D3DKMT_QUERYSTATISTICS {
            Type: D3DKMT_QUERYSTATISTICS_NODE,
            AdapterLuid: adapter.luid,
            ..Default::default()
        };
        query.Anonymous.QueryNode = D3DKMT_QUERYSTATISTICS_QUERY_NODE { NodeId: node };
        running.push(if statistics(&mut query) {
            unsafe {
                query
                    .QueryResult
                    .NodeInformation
                    .GlobalInformation
                    .RunningTime
            }
        } else {
            0
        });
    }
    let now = Instant::now();
    let load = adapter.nodes.as_ref().map(|previous| {
        // RunningTime is in 100 ns units.
        let wall = now.duration_since(previous.at).as_secs_f64() * 1e7;
        let busiest = running
            .iter()
            .zip(&previous.running)
            .map(|(now, before)| (now - before).max(0) as f64)
            .fold(0.0, f64::max);
        (busiest / wall * 100.0).clamp(0.0, 100.0) as f32
    });
    adapter.nodes = Some(NodeClock { running, at: now });
    load
}

/// Loads a GPU vendor DLL from System32 only, where the drivers install them. A bare name would also
/// search the app's folder and PATH, letting a planted DLL of the same name run inside Open Dock.
pub(super) fn load_system_library(name: &str) -> Option<libloading::Library> {
    use libloading::os::windows::{Library, LOAD_LIBRARY_SEARCH_SYSTEM32};
    unsafe { Library::load_with_flags(name, LOAD_LIBRARY_SEARCH_SYSTEM32) }
        .ok()
        .map(Into::into)
}

/// Absolute path of a file in System32, for libraries that take a path (NVML).
pub(super) fn system32(name: &str) -> std::path::PathBuf {
    let mut buffer = [0u16; 260];
    let len = unsafe {
        windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(&mut buffer))
    } as usize;
    std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..len.min(buffer.len())])).join(name)
}

/// PCI ids of every present display device, with or without a driver.
fn display_devices() -> Vec<(u32, u32, u32)> {
    let mut devices = Vec::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(
            Some(&GUID_DEVCLASS_DISPLAY),
            PCWSTR::null(),
            None,
            DIGCF_PRESENT,
        ) else {
            return devices;
        };
        for index in 0.. {
            let mut data = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInfo(set, index, &mut data).is_err() {
                break;
            }
            let mut buffer = [0u16; 512];
            if SetupDiGetDeviceInstanceIdW(set, &data, Some(&mut buffer), None).is_ok() {
                let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                if let Some(ids) = parse::pci_ids(&String::from_utf16_lossy(&buffer[..len])) {
                    devices.push(ids);
                }
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    devices
}

/// The performance counters Open Dock reads, in one PDH query.
struct Counters {
    query: PDH_HQUERY,
    engine: Option<PDH_HCOUNTER>,
    dedicated: Option<PDH_HCOUNTER>,
    shared: Option<PDH_HCOUNTER>,
    /// Thermal zone counter, and whether it's in tenths of a kelvin.
    thermal: Option<(PDH_HCOUNTER, bool)>,
}

impl Counters {
    fn open() -> Option<Self> {
        let mut query = PDH_HQUERY::default();
        if unsafe { PdhOpenQueryW(None, 0, &mut query) } != 0 {
            return None;
        }
        let add = |path: PCWSTR| {
            let mut counter = PDH_HCOUNTER::default();
            (unsafe { PdhAddEnglishCounterW(query, path, 0, &mut counter) } == 0).then_some(counter)
        };
        // OPEN_DOCK_SENSOR_NO_COUNTERS=1 forces the D3DKMT load fallback, for testing it on a normal PC.
        let skip_gpu = std::env::var("OPEN_DOCK_SENSOR_NO_COUNTERS").ok().as_deref() == Some("1");
        let counters = Self {
            query,
            engine: if skip_gpu {
                None
            } else {
                add(w!(r"\GPU Engine(*)\Utilization Percentage"))
            },
            dedicated: if skip_gpu {
                None
            } else {
                add(w!(r"\GPU Adapter Memory(*)\Dedicated Usage"))
            },
            shared: if skip_gpu {
                None
            } else {
                add(w!(r"\GPU Adapter Memory(*)\Shared Usage"))
            },
            thermal: add(w!(
                r"\Thermal Zone Information(*)\High Precision Temperature"
            ))
            .map(|counter| (counter, true))
            .or_else(|| {
                add(w!(r"\Thermal Zone Information(*)\Temperature")).map(|counter| (counter, false))
            }),
        };
        // Rates need two collections; this is the first.
        counters.collect();
        Some(counters)
    }

    fn collect(&self) {
        unsafe { PdhCollectQueryData(self.query) };
    }

    /// Every instance of a wildcard counter as (instance name, value).
    fn values(&self, counter: PDH_HCOUNTER) -> Vec<(String, f64)> {
        unsafe {
            let (mut size, mut count) = (0u32, 0u32);
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
                != PDH_MORE_DATA
            {
                return Vec::new();
            }
            // The buffer holds the items followed by their instance names; size is in bytes.
            let item = size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
            let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); size as usize / item + 1];
            if PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(items.as_mut_ptr()),
            ) != 0
            {
                return Vec::new();
            }
            items[..count as usize]
                .iter()
                .filter(|item| item.FmtValue.CStatus == 0)
                .map(|item| {
                    (
                        item.szName.to_string().unwrap_or_default(),
                        item.FmtValue.Anonymous.doubleValue,
                    )
                })
                .collect()
        }
    }

    /// GPU load per adapter LUID: per-process engine use summed per engine, then the busiest engine,
    /// which is how Task Manager computes it.
    fn engine_loads(&self) -> HashMap<String, f32> {
        let Some(counter) = self.engine else {
            return HashMap::new();
        };
        let mut engines: HashMap<(String, u32), f64> = HashMap::new();
        for (name, value) in self.values(counter) {
            if let Some(key) = parse::engine_instance(&name) {
                *engines.entry(key).or_default() += value;
            }
        }
        let mut loads: HashMap<String, f32> = HashMap::new();
        for ((luid, _), value) in engines {
            let load = loads.entry(luid).or_default();
            *load = load.max(value.clamp(0.0, 100.0) as f32);
        }
        loads
    }

    /// Bytes in use per adapter LUID.
    fn memory(&self, counter: Option<PDH_HCOUNTER>) -> HashMap<String, f64> {
        let Some(counter) = counter else {
            return HashMap::new();
        };
        self.values(counter)
            .into_iter()
            .filter_map(|(name, value)| Some((parse::adapter_instance(&name)?, value)))
            .collect()
    }
}

impl Drop for Counters {
    fn drop(&mut self) {
        unsafe { PdhCloseQuery(self.query) };
    }
}
