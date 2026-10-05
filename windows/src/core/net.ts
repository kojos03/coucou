// Internet speed in the island's header: bits per second as people read them
// on a speed test (kbps, Mbps, Gbps).

export function formatSpeed(bitsPerSecond: number): string {
  const bps = Math.max(0, bitsPerSecond);
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e7) return `${Math.round(bps / 1e6)} Mbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}
