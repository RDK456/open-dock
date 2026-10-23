//! Samples this PC's load, temperatures and memory once a second for the PC stats widgets.
//! CPU, RAM, disk and network come from sysinfo on every platform. GPUs and temperatures come from
//! the platform module, which detects each GPU and fills its readings from a stack of sources:
//! the vendor's library first (NVML, ADLX/ADL, IGCL), then OS telemetry that works for any vendor,
//! then fallbacks for old and integrated GPUs. A source only fills readings still empty, and every
//! reading records which source supplied it (`sources`), shown in the desktop's Sensor sources panel.
//! A reading nothing can provide stays None and the widget explains why.
mod parse;

#[cfg(windows)]
mod amd;
#[cfg(windows)]
mod intel;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod nvidia;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
use macos::Sensors;
#[cfg(windows)]
use windows::Sensors;

use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io::Write,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{DiskRefreshKind, Disks, Networks, System};
use tokio::sync::watch;

/// Seconds of history kept; the widgets graph the last minute.
const HISTORY: usize = 60;
const GB: f32 = 1_073_741_824.0;

pub(super) type PcStatsHistory = Arc<VecDeque<PcStats>>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    #[default]
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum GpuKind {
    Integrated,
    Discrete,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) enum GpuState {
    #[default]
    Ok,
    /// A hybrid laptop's discrete GPU powered down; reading it would wake it.
    Sleeping,
    /// The GPU is in the PC but has no working driver, so nothing can read it.
    NoDriver,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum MemKind {
    Dedicated,
    Shared,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Unified,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GpuStats {
    /// Stable across reboots; widgets store it to follow one GPU.
    id: String,
    name: String,
    vendor: Vendor,
    kind: GpuKind,
    state: GpuState,
    load: Option<f32>,
    temp: Option<f32>,
    /// True when `temp` is an estimate, e.g. an integrated GPU using its CPU's die temperature.
    temp_approx: bool,
    hotspot: Option<f32>,
    /// Watts.
    power: Option<f32>,
    power_limit: Option<f32>,
    /// Share of the power limit, for sources that report power only that way (D3DKMT).
    power_percent: Option<f32>,
    fan: Option<f32>,
    fan_rpm: Option<f32>,
    /// GB.
    mem_used: Option<f32>,
    mem_total: Option<f32>,
    mem_kind: MemKind,
    /// Reading name -> source that supplied it.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    sources: BTreeMap<&'static str, &'static str>,
}

/// Fills `$gpu.$field` from `$value` (an Option) only if it's still empty, and records `$source`.
macro_rules! fill {
    ($gpu:expr, $field:ident, $source:expr, $value:expr) => {
        if $gpu.$field.is_none() {
            if let Some(value) = $value {
                $gpu.$field = Some(value);
                $gpu.sources.insert(stringify!($field), $source);
            }
        }
    };
}
use fill;

/// Readings a vendor library can supply for one GPU.
#[cfg(windows)]
#[derive(Debug, Default)]
pub(super) struct VendorReadings {
    temp: Option<f32>,
    hotspot: Option<f32>,
    power: Option<f32>,
    power_limit: Option<f32>,
    fan: Option<f32>,
    fan_rpm: Option<f32>,
    load: Option<f32>,
    mem_used: Option<f32>,
    mem_total: Option<f32>,
}

#[cfg(windows)]
impl GpuStats {
    fn fill_vendor(&mut self, source: &'static str, readings: VendorReadings) {
        fill!(self, temp, source, readings.temp);
        fill!(self, hotspot, source, readings.hotspot);
        fill!(self, power, source, readings.power);
        fill!(self, power_limit, source, readings.power_limit);
        fill!(self, fan, source, readings.fan);
        fill!(self, fan_rpm, source, readings.fan_rpm);
        fill!(self, load, source, readings.load);
        fill!(self, mem_used, source, readings.mem_used);
        fill!(self, mem_total, source, readings.mem_total);
    }
}

/// A CPU temperature and how it was measured.
#[derive(Clone, Copy, Debug)]
pub(super) struct CpuTemp {
    celsius: f32,
    approx: bool,
    source: &'static str,
}

/// The readings to sample. Widgets name what they show with OpenDockStats.needs() in pc-stats.js
/// ("cpu", "gpu", "net", ...); the PC samples the union of what's on screen and nothing else.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Needs(u16);

impl Needs {
    pub(super) const CPU: Needs = Needs(1);
    pub(super) const CORES: Needs = Needs(1 << 1);
    pub(super) const CLOCK: Needs = Needs(1 << 2);
    pub(super) const CPUTEMP: Needs = Needs(1 << 3);
    /// Every per-GPU reading: load, temperature, memory, power and fans.
    pub(super) const GPU: Needs = Needs(1 << 4);
    pub(super) const RAM: Needs = Needs(1 << 5);
    pub(super) const DISK: Needs = Needs(1 << 6);
    pub(super) const DISKIO: Needs = Needs(1 << 7);
    pub(super) const NET: Needs = Needs(1 << 8);
    const NAMES: [(&'static str, Needs); 9] = [
        ("cpu", Needs::CPU),
        ("cores", Needs::CORES),
        ("clock", Needs::CLOCK),
        ("cputemp", Needs::CPUTEMP),
        ("gpu", Needs::GPU),
        ("ram", Needs::RAM),
        ("disk", Needs::DISK),
        ("diskio", Needs::DISKIO),
        ("net", Needs::NET),
    ];

    /// From reading names; unknown names are ignored.
    pub(super) fn from_names<S: AsRef<str>>(names: &[S]) -> Self {
        names.iter().fold(Needs(0), |all, name| {
            Self::NAMES
                .iter()
                .find(|(known, _)| *known == name.as_ref())
                .map_or(all, |(_, need)| all | *need)
        })
    }

    fn has(self, other: Needs) -> bool {
        self.0 & other.0 != 0
    }

    fn is_empty(self) -> bool {
        self.0 == 0
    }

    fn without(self, other: Needs) -> Needs {
        Needs(self.0 & !other.0)
    }
}

impl std::ops::BitOr for Needs {
    type Output = Needs;
    fn bitor(self, other: Needs) -> Needs {
        Needs(self.0 | other.0)
    }
}

/// Who wants which readings: each connected phone (by connection id) and the desktop editor.
/// The desktop's entry expires unless it keeps polling, so closing the editor stops sampling.
#[derive(Default)]
pub(super) struct Demand(Mutex<HashMap<u64, (Needs, Option<Instant>)>>);

/// The desktop editor's id in `Demand`; phone connections count up from 1.
pub(super) const DESKTOP: u64 = 0;

impl Demand {
    pub(super) fn set(&self, client: u64, needs: Needs, lasts: Option<Duration>) {
        if let Ok(mut entries) = self.0.lock() {
            if needs.is_empty() {
                entries.remove(&client);
            } else {
                entries.insert(client, (needs, lasts.map(|ttl| Instant::now() + ttl)));
            }
        }
    }

    pub(super) fn remove(&self, client: u64) {
        self.set(client, Needs::default(), None);
    }

    fn current(&self) -> Needs {
        let Ok(mut entries) = self.0.lock() else {
            return Needs::default();
        };
        let now = Instant::now();
        entries.retain(|_, (_, until)| until.is_none_or(|until| until > now));
        entries
            .values()
            .fold(Needs::default(), |all, (needs, _)| all | *needs)
    }
}

/// One second's readings. Readings nobody asked for are left out of the JSON.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PcStats {
    /// Counts up by one per sample, so the desktop can fetch only what it hasn't seen.
    pub(super) seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cputemp: Option<f32>,
    cputemp_approx: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cputemp_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clock: Option<f32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cores: Vec<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ram: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ram_used: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ram_total: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_used: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_total: Option<f32>,
    /// Disk reads plus writes across fixed disks, MB/s; `disk_read` and `disk_write` split it.
    #[serde(skip_serializing_if = "Option::is_none")]
    diskio: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_read: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_write: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    net: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    net_up: Option<f32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) gpus: Vec<GpuStats>,
}

impl PcStats {
    /// The sample as the phone gets it: without the per-reading sources, which only the desktop's
    /// Sensor sources panel shows.
    pub(super) fn for_phone(&self) -> PcStats {
        let mut sample = self.clone();
        sample.gpus.iter_mut().for_each(|gpu| gpu.sources.clear());
        sample
    }
}

/// One decimal is all the widgets show; it keeps the JSON short.
fn round(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

/// Bytes over `seconds` as MB/s, kept to 1 KB/s so slow traffic doesn't round to zero.
fn rate(bytes: u64, seconds: f32) -> f32 {
    (bytes as f32 / 1_000.0 / seconds).round() / 1_000.0
}

fn percent(used: f32, total: f32) -> Option<f32> {
    (total > 0.0).then(|| round(used / total * 100.0))
}

/// An integrated GPU shares its die with the CPU, so with no sensor of its own its temperature is
/// the CPU's. Marked approximate.
fn integrated_temp_from_cpu(gpus: &mut [GpuStats], cpu: Option<CpuTemp>) {
    let Some(cpu) = cpu else { return };
    for gpu in gpus.iter_mut().filter(|gpu| {
        gpu.kind == GpuKind::Integrated && gpu.state == GpuState::Ok && gpu.temp.is_none()
    }) {
        gpu.temp = Some(round(cpu.celsius));
        gpu.temp_approx = true;
        gpu.sources.insert("temp", "cpu-die");
    }
}

/// The system drive: "/" or Windows' SystemDrive, else the largest fixed disk.
fn system_disk(disks: &Disks) -> Option<(f32, f32)> {
    let system_drive = std::env::var("SystemDrive").unwrap_or_default();
    let fixed = || {
        disks
            .iter()
            .filter(|disk| !disk.is_removable() && disk.total_space() > 0)
    };
    let disk = fixed()
        .find(|disk| {
            let mount = disk.mount_point().to_string_lossy();
            mount == "/" || (!system_drive.is_empty() && mount.starts_with(&system_drive))
        })
        .or_else(|| fixed().max_by_key(|disk| disk.total_space()))?;
    let total = disk.total_space() as f32 / GB;
    Some((total - disk.available_space() as f32 / GB, total))
}

/// Platforms without GPU and temperature sources yet (Linux): CPU, memory, disk and network only.
#[cfg(not(any(windows, target_os = "macos")))]
struct Sensors;
#[cfg(not(any(windows, target_os = "macos")))]
impl Sensors {
    fn new() -> Self {
        Sensors
    }
    fn cpu_temp(&mut self, _cpu_load: f32) -> Option<CpuTemp> {
        None
    }
    fn gpus(&mut self, _ram_total_gb: f32) -> Vec<GpuStats> {
        Vec::new()
    }
    fn dump(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// With OPEN_DOCK_SENSOR_DUMP=1 every sample and the platform's raw readings are appended to
/// open-dock-sensor-dump.jsonl in the temp folder, so a tester's machine can become a test fixture.
fn open_dump() -> Option<std::fs::File> {
    if std::env::var("OPEN_DOCK_SENSOR_DUMP").ok().as_deref() != Some("1") {
        return None;
    }
    let path = std::env::temp_dir().join("open-dock-sensor-dump.jsonl");
    eprintln!("Open Dock: writing sensor dump to {}", path.display());
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// Samples once a second what `demand` asks for, and nothing while nobody asks: no stats widget on
/// the phone's current page and no preview in the desktop editor. GPU detection, vendor libraries and
/// the thermal sensor run only for widgets that show a GPU reading or a temperature.
pub(super) fn spawn_pc_stats_monitor(updates: watch::Sender<PcStatsHistory>, demand: Arc<Demand>) {
    thread::spawn(move || {
        let mut system = System::new();
        let mut networks = Networks::new();
        let mut disks = Disks::new();
        let mut sensors: Option<Sensors> = None;
        let mut dump = open_dump();
        let mut history = VecDeque::with_capacity(HISTORY);
        let mut last_sample = Instant::now();
        let mut before = Needs::default();
        let mut seq = 0u64;
        // CPU usage is measured between refreshes; this is the first one.
        system.refresh_cpu_usage();
        for tick in 0u64.. {
            thread::sleep(Duration::from_secs(1));
            let needs = demand.current();
            if needs.is_empty() {
                if !history.is_empty() {
                    history.clear();
                    updates.send_replace(Arc::new(VecDeque::new()));
                }
                // Platform sensors (PDH queries, GPU handles, vendor libraries) are released while idle.
                sensors = None;
                before = needs;
                continue;
            }
            let elapsed = last_sample.elapsed().as_secs_f32().max(0.1);
            last_sample = Instant::now();
            // Counters report what happened since their last refresh, so a reading that was off
            // primes its counter this second and reports from the next.
            let fresh = needs.without(before);
            before = needs;

            system.refresh_cpu_usage();
            if needs.has(Needs::RAM | Needs::GPU) {
                system.refresh_memory();
            }
            if needs.has(Needs::CLOCK) && (fresh.has(Needs::CLOCK) || tick % 10 == 0) {
                system.refresh_cpu_frequency();
            }
            if needs.has(Needs::NET) {
                networks.refresh(true);
            }
            if needs.has(Needs::DISK) && (fresh.has(Needs::DISK) || tick % 30 == 0) {
                disks.refresh(true);
            } else if needs.has(Needs::DISKIO) {
                disks.refresh_specifics(true, DiskRefreshKind::nothing().with_io_usage());
            }

            seq += 1;
            let cpu = round(system.global_cpu_usage());
            let (ram_used, ram_total) = (
                system.used_memory() as f32 / GB,
                system.total_memory() as f32 / GB,
            );
            let mut stats = PcStats {
                seq,
                ..PcStats::default()
            };
            if needs.has(Needs::CPU) {
                stats.cpu = Some(cpu);
            }
            if needs.has(Needs::CORES) {
                stats.cores = system
                    .cpus()
                    .iter()
                    .map(|cpu| cpu.cpu_usage().round())
                    .collect();
            }
            if needs.has(Needs::CLOCK) {
                // Apple Silicon and some VMs report 0; the widget then hides the clock.
                stats.clock = system
                    .cpus()
                    .first()
                    .map(|cpu| cpu.frequency())
                    .filter(|mhz| *mhz > 0)
                    .map(|mhz| (mhz as f32 / 10.0).round() / 100.0);
            }
            if needs.has(Needs::RAM) {
                stats.ram = percent(ram_used, ram_total);
                stats.ram_used = Some(round(ram_used));
                stats.ram_total = Some(round(ram_total));
            }
            // An integrated GPU's temperature comes from the CPU's, so GPU readings need it too.
            if needs.has(Needs::CPUTEMP | Needs::GPU) {
                let platform = sensors.get_or_insert_with(Sensors::new);
                let cpu_temp = platform.cpu_temp(cpu);
                if needs.has(Needs::CPUTEMP) {
                    stats.cputemp = cpu_temp.map(|temp| round(temp.celsius));
                    stats.cputemp_approx = cpu_temp.is_some_and(|temp| temp.approx);
                    stats.cputemp_source = cpu_temp.map(|temp| temp.source);
                }
                if needs.has(Needs::GPU) {
                    stats.gpus = platform.gpus(ram_total);
                    integrated_temp_from_cpu(&mut stats.gpus, cpu_temp);
                }
            } else {
                sensors = None;
            }
            if needs.has(Needs::DISK) {
                if let Some((used, total)) = system_disk(&disks) {
                    stats.disk = percent(used, total);
                    stats.disk_used = Some(round(used));
                    stats.disk_total = Some(round(total));
                }
            }
            if needs.has(Needs::DISKIO) && !fresh.has(Needs::DISKIO) {
                let (read, written) = disks.iter().filter(|disk| !disk.is_removable()).fold(
                    (0u64, 0u64),
                    |(read, written), disk| {
                        let usage = disk.usage();
                        (read + usage.read_bytes, written + usage.written_bytes)
                    },
                );
                stats.disk_read = Some(rate(read, elapsed));
                stats.disk_write = Some(rate(written, elapsed));
                stats.diskio = Some(rate(read + written, elapsed));
            }
            if needs.has(Needs::NET) && !fresh.has(Needs::NET) {
                let (down, up) = networks.iter().fold((0u64, 0u64), |(down, up), (_, data)| {
                    (down + data.received(), up + data.transmitted())
                });
                stats.net = Some(rate(down, elapsed));
                stats.net_up = Some(rate(up, elapsed));
            }

            if let Some(file) = &mut dump {
                let raw = sensors.as_ref().map(Sensors::dump);
                let line = serde_json::json!({ "stats": &stats, "raw": raw });
                let _ = writeln!(file, "{line}");
            }
            if history.len() == HISTORY {
                history.pop_front();
            }
            history.push_back(stats);
            updates.send_replace(Arc::new(history.clone()));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn fill_keeps_the_first_source() {
        let mut gpu = GpuStats::default();
        gpu.fill_vendor(
            "nvml",
            VendorReadings {
                temp: Some(61.0),
                ..VendorReadings::default()
            },
        );
        fill!(gpu, temp, "d3dkmt", Some(70.0));
        fill!(gpu, fan_rpm, "d3dkmt", Some(1500.0));
        fill!(gpu, power, "d3dkmt", None::<f32>);
        assert_eq!(gpu.temp, Some(61.0));
        assert_eq!(gpu.sources.get("temp"), Some(&"nvml"));
        assert_eq!(gpu.fan_rpm, Some(1500.0));
        assert_eq!(gpu.sources.get("fan_rpm"), Some(&"d3dkmt"));
        assert!(!gpu.sources.contains_key("power"));
    }

    /// Prints this machine's readings: `cargo test --lib live_sample -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads this machine's sensors"]
    fn live_sample() {
        // OPEN_DOCK_LIVE_SECONDS=75 watches longer, e.g. past GPU re-detection at 30 s.
        let seconds: f32 = std::env::var("OPEN_DOCK_LIVE_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4.5);
        let (updates, mut samples) = watch::channel(PcStatsHistory::default());
        let demand = Arc::new(Demand::default());
        // OPEN_DOCK_LIVE_NEEDS=gpu,net samples only those readings (default: everything).
        let names = std::env::var("OPEN_DOCK_LIVE_NEEDS")
            .unwrap_or_else(|_| "cpu,cores,clock,cputemp,gpu,ram,disk,diskio,net".into());
        demand.set(
            DESKTOP,
            Needs::from_names(&names.split(',').collect::<Vec<_>>()),
            None,
        );
        spawn_pc_stats_monitor(updates, demand);
        // CPU this process uses while sampling, after a 3 s warm-up.
        let cpu_ms = || {
            let mut system = System::new();
            let pid = sysinfo::get_current_pid().unwrap();
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            system.process(pid).map_or(0, |process| process.accumulated_cpu_time())
        };
        thread::sleep(Duration::from_secs(3));
        let (start_ms, started) = (cpu_ms(), Instant::now());
        thread::sleep(Duration::from_secs_f32((seconds - 3.0).max(1.0)));
        println!(
            "sampler CPU: {:.1}% of a core for {names}",
            (cpu_ms() - start_ms) as f64 / started.elapsed().as_millis() as f64 * 100.0
        );
        let history = samples.borrow_and_update().clone();
        println!(
            "{}",
            serde_json::to_string_pretty(history.back().expect("no sample")).unwrap()
        );
        for sample in history.iter() {
            let gpus: Vec<_> = sample
                .gpus
                .iter()
                .map(|gpu| (gpu.load, gpu.mem_used))
                .collect();
            println!(
                "cpu {:?} cputemp {:?} ram {:?} net {:?} up {:?} diskio {:?} gpus(load,mem) {gpus:?}",
                sample.cpu, sample.cputemp, sample.ram, sample.net, sample.net_up, sample.diskio
            );
        }
    }

    #[test]
    fn demand_is_the_union_of_live_requests() {
        let demand = Demand::default();
        demand.set(1, Needs::from_names(&["net", "unknown"]), None);
        demand.set(
            DESKTOP,
            Needs::from_names(&["gpu"]),
            Some(Duration::from_millis(0)),
        );
        demand.set(
            2,
            Needs::from_names(&["cpu", "cputemp"]),
            Some(Duration::from_secs(60)),
        );
        // The desktop entry has already expired.
        assert_eq!(demand.current(), Needs::NET | Needs::CPU | Needs::CPUTEMP);
        demand.remove(1);
        demand.set(2, Needs::default(), None);
        assert!(demand.current().is_empty());
        assert_eq!(
            Needs::from_names(&["cpu", "net"]).without(Needs::CPU),
            Needs::NET
        );
    }

    /// With nothing on screen the sampler records nothing; asking for a reading starts it, and the
    /// sample carries only what was asked for.
    #[test]
    fn samples_only_on_demand() {
        let (updates, mut samples) = watch::channel(PcStatsHistory::default());
        let demand = Arc::new(Demand::default());
        spawn_pc_stats_monitor(updates, demand.clone());
        thread::sleep(Duration::from_millis(2500));
        assert!(samples.borrow_and_update().is_empty(), "sampled with no demand");
        demand.set(1, Needs::from_names(&["ram"]), None);
        thread::sleep(Duration::from_millis(2500));
        let history = samples.borrow_and_update().clone();
        let newest = history.back().expect("no sample after asking for RAM");
        assert!(newest.ram.is_some());
        assert!(newest.cpu.is_none() && newest.gpus.is_empty() && newest.net.is_none() && newest.cputemp.is_none());
        demand.remove(1);
        thread::sleep(Duration::from_millis(2500));
        assert!(samples.borrow_and_update().is_empty(), "kept sampling after demand ended");
    }

    #[test]
    fn rates_keep_kilobytes() {
        assert_eq!(rate(24_000, 1.0), 0.024);
        assert_eq!(rate(3_000_000, 2.0), 1.5);
        assert_eq!(rate(400, 1.0), 0.0);
    }

    #[test]
    fn integrated_gpu_borrows_cpu_temperature() {
        let cpu = Some(CpuTemp {
            celsius: 71.26,
            approx: true,
            source: "thermal-zone",
        });
        let mut gpus = vec![
            GpuStats {
                kind: GpuKind::Integrated,
                ..GpuStats::default()
            },
            GpuStats {
                kind: GpuKind::Discrete,
                ..GpuStats::default()
            },
            GpuStats {
                kind: GpuKind::Integrated,
                temp: Some(50.0),
                ..GpuStats::default()
            },
            GpuStats {
                kind: GpuKind::Integrated,
                state: GpuState::NoDriver,
                ..GpuStats::default()
            },
        ];
        integrated_temp_from_cpu(&mut gpus, cpu);
        assert_eq!((gpus[0].temp, gpus[0].temp_approx), (Some(71.3), true));
        assert_eq!(gpus[1].temp, None);
        assert_eq!((gpus[2].temp, gpus[2].temp_approx), (Some(50.0), false));
        assert_eq!(gpus[3].temp, None);
    }
}
