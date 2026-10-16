/** Lives inside a shadow root: page CSS can't reach in, and nothing here leaks out. */
export const UI_CSS = /* css */ `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.layer {
  --ink: #17181c;
  --muted: #646a73;
  --faint: #979ca5;
  --surface: rgba(255, 255, 255, 0.86);
  --solid: #ffffff;
  --line: rgba(17, 19, 26, 0.09);
  --hover: rgba(17, 19, 26, 0.055);
  --accent: #0f8b7a;
  --accent-ink: #ffffff;
  --accent-soft: rgba(15, 139, 122, 0.12);
  --danger: #d6455d;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 14px 36px -10px rgba(16, 24, 40, 0.28);
  position: fixed;
  inset: 0;
  pointer-events: none;
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  letter-spacing: 0;
}
@media (prefers-color-scheme: dark) {
  .layer {
    --ink: #eceef2;
    --muted: #a5abb4;
    --faint: #767c86;
    --surface: rgba(28, 30, 35, 0.84);
    --solid: #2b2e35;
    --line: rgba(255, 255, 255, 0.09);
    --hover: rgba(255, 255, 255, 0.07);
    --accent: #34c7ae;
    --accent-ink: #052019;
    --accent-soft: rgba(52, 199, 174, 0.16);
    --danger: #ff7a8e;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 18px 44px -12px rgba(0, 0, 0, 0.65);
  }
}

.glass {
  background: var(--surface);
  -webkit-backdrop-filter: blur(22px) saturate(1.7);
  backdrop-filter: blur(22px) saturate(1.7);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

button { font: inherit; }
.icon-btn {
  all: unset;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--faint);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--hover); color: var(--ink); }
.icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.icon-btn svg { width: 15px; height: 15px; }
.icon-btn.is-ok { color: var(--accent); }

/* ───────── HUD (floating mode switcher) ───────── */
.hud {
  position: fixed;
  right: 18px;
  bottom: 18px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 999px;
  transform-origin: right bottom;
  animation: pop-in 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.15);
}
.hud[hidden] { display: none; }
.badge {
  position: relative;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--accent-ink);
}
.badge > svg:first-child { width: 16px; height: 16px; }
.ring { position: absolute; inset: -3px; width: 38px; height: 38px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; opacity: 0.35; transition: stroke-dashoffset 0.35s ease; }
.hud.is-working .ring circle { opacity: 1; }
.hud-body {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 460px;
  padding-left: 8px;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width 0.35s cubic-bezier(0.3, 0.9, 0.3, 1), opacity 0.25s, padding 0.35s;
}
.hud.is-collapsed:not(:hover):not(:focus-within) .hud-body { max-width: 0; opacity: 0; padding-left: 0; }
.status {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status.is-error { color: var(--danger); }
.seg {
  position: relative;
  display: flex;
  padding: 2px;
  border-radius: 999px;
  background: var(--hover);
}
.seg button {
  all: unset;
  position: relative;
  z-index: 1;
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 550;
  color: var(--muted);
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.2s;
}
.seg button:hover { color: var(--ink); }
.seg button[aria-checked="true"] { color: var(--ink); }
.seg button:focus-visible { outline: 2px solid var(--accent); }
.thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  border-radius: 999px;
  background: var(--solid);
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.14), 0 0 0 0.5px var(--line);
  transition: transform 0.3s cubic-bezier(0.3, 0.9, 0.3, 1), width 0.3s cubic-bezier(0.3, 0.9, 0.3, 1);
}
.retry-btn {
  all: unset;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 550;
  color: var(--danger);
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 11%, transparent);
  cursor: pointer;
}
.retry-btn svg { width: 12px; height: 12px; }
.retry-btn[hidden] { display: none; }

/* ───────── Selection trigger + card ───────── */
.trigger {
  all: unset;
  position: fixed;
  pointer-events: auto;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: var(--accent);
  cursor: pointer;
  animation: pop-in 0.18s cubic-bezier(0.2, 0.9, 0.25, 1.2);
  transition: background 0.15s, color 0.15s, transform 0.15s;
}
.trigger:hover { background: var(--accent); color: var(--accent-ink); transform: translateY(-1px); }
.trigger svg { width: 16px; height: 16px; }
.trigger[hidden], .card[hidden] { display: none; }

.card {
  position: fixed;
  pointer-events: auto;
  width: 368px;
  max-width: calc(100vw - 24px);
  border-radius: 16px;
  overflow: hidden;
  animation: card-in 0.24s cubic-bezier(0.2, 0.9, 0.25, 1);
}
.card-head { display: flex; align-items: center; gap: 2px; padding: 10px 8px 6px 14px; }
.chip {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 9px;
  border-radius: 999px;
  margin-right: auto;
}
.source {
  margin: 0 14px;
  padding-left: 9px;
  border-left: 2px solid var(--line);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.result {
  padding: 10px 14px 14px;
  font-size: 14.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: min(340px, 50vh);
  overflow: auto;
  overscroll-behavior: contain;
}
.result.is-error { color: var(--danger); font-size: 13px; }
.caret {
  display: inline-block;
  width: 6px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -0.17em;
  border-radius: 2px;
  background: var(--accent);
  animation: blink 1s steps(2, start) infinite;
}
.skeleton { display: grid; gap: 9px; padding: 6px 0 2px; }
.skeleton i {
  display: block;
  height: 10px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--hover) 25%, var(--line) 50%, var(--hover) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s linear infinite;
}
.skeleton i:last-child { width: 62%; }

@keyframes pop-in { from { opacity: 0; transform: scale(0.82); } }
@keyframes card-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } }
@keyframes blink { to { visibility: hidden; } }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
