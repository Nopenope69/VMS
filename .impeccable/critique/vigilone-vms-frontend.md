---
target: "vigilone-vms-frontend"
total_score: 18
max_score: 40
na_heuristics: ""
p0_count: 2
p1_count: 3
created_at: "2026-09-17T12:11:00+05:30"
method: "dual-agent (A: ca962473-0878-494a-b534-5be649ec6d11 · B: 9bb65dbc-aeef-41c6-ad19-f46b777740e6)"
---

# VigilOne VMS Frontend — Impeccable Critique Snapshot

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2/4 | Real-time OSD clock & REC beacon active, but 15s alarm polling desync & hardcoded 1080P/H.264 telemetry |
| 2 | Match System / Real World | 3/4 | Precise Section 63 BSA terms & PTZ conventions, but nav label mismatch and slot unassign X icon |
| 3 | User Control and Freedom | 1/4 | Escape dismiss works, but 9 blocking confirm calls, no video double-click maximize, no export abort |
| 4 | Consistency and Standards | 1/4 | Dual-theme token schism: 15 secondary modals rely on 704 undefined graphite-*/cctv-* classes |
| 5 | Error Prevention | 2/4 | Strong wizard password complexity, but zero-confirm operator deactivation and global hotkey hijacking |
| 6 | Recognition Rather Than Recall | 2/4 | Visual hotkey badges & SHA-256 copy buttons, but empty grid slots lack pickers and PTS shown as raw unix integers |
| 7 | Flexibility and Efficiency | 1/4 | Global key navigation present, but grid hotkey collision strips operators from LiveView, no J-K-L shuttle or Spacebar in Investigation |
| 8 | Aesthetic and Minimalist Design | 2/4 | Video canvas is dark and quiet, but 250-320px SaaS bloat & static KPI cards crowd out real estate on 1080p screens |
| 9 | Error Recovery | 2/4 | Storage reconcile report is good, but 34 blocking native alert popups and raw API error strings dumped to UI |
| 10 | Help and Documentation | 2/4 | Legal notice & scope boundaries clear, but no hotkey cheatsheet overlay and unexplained signing modes |
| **Total** | | **18/40** | **Poor (Major UX overhaul required)** |

## Priority Issues
1. **[P0] Design System Token Schism**: 704 occurrences of undefined `graphite-*` and `cctv-*` classes across 15 modal files resulting in transparent/unstyled production renders.
2. **[P0] Keyboard Accelerator Collision**: Bare number keys `1`-`0` in `Navbar.tsx` hijack local grid commands `[1]`, `[2]`, `[3]` in `LiveView.tsx` and abort active sync playback sessions in `Investigation.tsx`.
3. **[P1] 43 Blocking Native Browser `alert()` and `confirm()` Dialogs**: Freezes the JS main thread, dropping WebRTC media decoding and SSE/WebSocket heartbeats.
4. **[P1] "SaaS Bloat" Crowding Out Video-First Screen Real Estate**: 250-320px vertical headers, verbose marketing copy, and static KPI vanity cards push operational grids below the fold on 1080p control room displays.
5. **[P1] Alarm Dispatch Bottleneck & Alert Fatigue**: Operations console only supports 1-by-1 alarm acknowledgement and lacks bulk triage or canned resolution presets.
