// Live internet speed for the island's header: how fast this computer is
// downloading and uploading right now, from the network adapters' own byte
// counters, sampled once a second while the island is on screen. Nothing is
// downloaded to measure it and nothing is sent anywhere.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::island::{PollGate, WINDOW_LABEL};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetSpeed {
    /// Bits per second.
    pub down: f64,
    pub up: f64,
}

/// The rate between two readings of the byte counters, or None when the gap
/// is too short or long to mean "right now" (the island was hidden meanwhile).
fn rate(before: (Instant, u64, u64), after: (Instant, u64, u64)) -> Option<NetSpeed> {
    let secs = after.0.checked_duration_since(before.0)?.as_secs_f64();
    if !(0.2..=5.0).contains(&secs) {
        return None;
    }
    // A counter that went down is an adapter that went away: no rate this time.
    let down = after.1.checked_sub(before.1)? as f64 * 8.0 / secs;
    let up = after.2.checked_sub(before.2)? as f64 * 8.0 / secs;
    Some(NetSpeed { down, up })
}

pub fn start(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut last: Option<(Instant, u64, u64)> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if gate.collapsed.load(Ordering::Relaxed) {
                last = None;
                continue;
            }
            let Some((received, sent)) = totals() else { continue };
            let now = (Instant::now(), received, sent);
            if let Some(speed) = last.and_then(|before| rate(before, now)) {
                let _ = app.emit_to(WINDOW_LABEL, "net-speed", speed);
            }
            last = Some(now);
        }
    });
}

/// Bytes received and sent so far by the physical adapters that are up.
/// Filter drivers and virtual adapters (VPNs, Hyper-V switches) would count
/// the same traffic twice, and loopback none of it is internet.
#[cfg(windows)]
fn totals() -> Option<(u64, u64)> {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    const HARDWARE: u8 = 1;
    const FILTER: u8 = 2;
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).0 != 0 || table.is_null() {
            return None;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let (mut received, mut sent) = (0u64, 0u64);
        for row in rows {
            let flags = row.InterfaceAndOperStatusFlags._bitfield;
            if flags & HARDWARE != 0 && flags & FILTER == 0 && row.OperStatus == IfOperStatusUp {
                received = received.saturating_add(row.InOctets);
                sent = sent.saturating_add(row.OutOctets);
            }
        }
        FreeMibTable(table as *const _);
        Some((received, sent))
    }
}

/// /proc/net/dev: every interface but loopback.
#[cfg(target_os = "linux")]
fn totals() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/net/dev").ok()?;
    Some(proc_net_dev(&text))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn proc_net_dev(text: &str) -> (u64, u64) {
    text.lines()
        .skip(2)
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            if name.trim() == "lo" {
                return None;
            }
            let fields: Vec<u64> = rest.split_whitespace().filter_map(|f| f.parse().ok()).collect();
            Some((*fields.first()?, *fields.get(8)?))
        })
        .fold((0, 0), |(r, s), (dr, ds)| (r + dr, s + ds))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_of_counters_is_a_speed_in_bits() {
        let t = Instant::now();
        let speed = rate((t, 1_000, 500), (t + Duration::from_secs(2), 1_000 + 2_500_000, 500 + 125_000)).unwrap();
        assert_eq!(speed, NetSpeed { down: 10_000_000.0, up: 500_000.0 });
        // Too long a gap (the island was hidden), or a counter that went back.
        assert_eq!(rate((t, 0, 0), (t + Duration::from_secs(9), 10, 10)), None);
        assert_eq!(rate((t, 50, 0), (t + Duration::from_secs(1), 10, 10)), None);
    }

    #[test]
    fn linux_counts_every_interface_but_loopback() {
        let text = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 200 3 0 0 0 0 0 0\n wlan0: 50 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n";
        assert_eq!(proc_net_dev(text), (1050, 207));
    }

    #[test]
    #[cfg(windows)]
    fn the_adapters_can_be_read() {
        assert!(totals().is_some());
    }
}
