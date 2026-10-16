import { tokenCss } from '../../shared/design-tokens.mjs'

/**
 * Lives inside a shadow root: page CSS can't reach in, and nothing here leaks out. Colours, type,
 * shape and motion come from the Silk & Ink tokens (docs/DESIGN.md); no colour values here.
 */
export const UI_CSS = /* css */ `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

${tokenCss('.layer')}

.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font: 13px/20px var(--font-ui);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  letter-spacing: 0;
}

.glass {
  background: var(--surface);
  -webkit-backdrop-filter: blur(22px) saturate(1.6);
  backdrop-filter: blur(22px) saturate(1.6);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

button { font: inherit; }
.icon-btn {
  all: unset;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-silk), color var(--dur-fast) var(--ease-silk);
}
.icon-btn:hover { background: var(--hover); color: var(--ink); }
.icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.icon-btn svg { width: 15px; height: 15px; }
.icon-btn.is-ok { color: var(--ok); }
.icon-btn.is-on { color: var(--accent); }

/* ───────── HUD (floating mode switcher) ───────── */
.hud {
  position: fixed;
  right: 16px;
  bottom: 16px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 999px;
  transform-origin: right bottom;
  animation: rise-in var(--dur-slow) var(--ease-silk);
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
  background: var(--solid);
  border: 1px solid var(--line);
  color: var(--accent);
}
.badge > svg:first-child { width: 15px; height: 15px; }
/* Silk progress: a gold thread woven around the badge, gathered into a point when done. */
.ring { position: absolute; inset: -4px; width: 38px; height: 38px; transform: rotate(-90deg); overflow: visible; }
.ring circle {
  fill: none;
  stroke: var(--silk);
  stroke-width: 1.5;
  stroke-linecap: round;
  opacity: 0;
  transition: stroke-dashoffset var(--dur-slow) var(--ease-silk), opacity var(--dur) var(--ease-out);
}
.hud.is-working .ring circle { opacity: 1; }
.hud.is-done .ring circle { animation: silk-gather 640ms var(--ease-out) forwards; }
.hud-body {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 460px;
  padding-left: 8px;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width var(--dur-slow) var(--ease-silk), opacity var(--dur) var(--ease-out), padding var(--dur-slow) var(--ease-silk);
}
.hud.is-collapsed:not(:hover):not(:focus-within) .hud-body { max-width: 0; opacity: 0; padding-left: 0; }
.status {
  font-size: 12px;
  line-height: 16px;
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
  background: var(--field);
}
.seg button {
  all: unset;
  position: relative;
  z-index: 1;
  padding: 4px 12px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 550;
  color: var(--muted);
  border-radius: 999px;
  cursor: pointer;
  transition: color var(--dur) var(--ease-silk);
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
  border: 1px solid var(--line);
  transition: transform var(--dur) var(--ease-silk), width var(--dur) var(--ease-silk);
}
.retry-btn {
  all: unset;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 550;
  color: var(--danger);
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  cursor: pointer;
}
.retry-btn svg { width: 12px; height: 12px; }
.retry-btn[hidden] { display: none; }

/* ───────── Selection trigger + card ───────── */
.trigger {
  all: unset;
  position: fixed;
  pointer-events: auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--accent);
  cursor: pointer;
  animation: card-in var(--dur) var(--ease-silk);
  transition: background var(--dur-fast) var(--ease-silk), color var(--dur-fast) var(--ease-silk);
}
.trigger:hover { background: var(--accent); color: var(--accent-ink); }
.trigger svg { width: 15px; height: 15px; }
.trigger[hidden], .card[hidden] { display: none; }

.card {
  position: fixed;
  pointer-events: auto;
  width: 360px;
  max-width: calc(100vw - 24px);
  border-radius: var(--radius);
  overflow: hidden;
  transform-origin: left top;
  animation: card-in var(--dur) var(--ease-silk);
}
.card.is-above { transform-origin: left bottom; }
.card-head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 4px 16px; }
.chip {
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 550;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 999px;
  margin-right: auto;
}
.source {
  margin: 0 16px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The card's only decoration: a short gold thread between the original and the translation. */
.silk-rule { width: 24px; height: 1px; margin: 8px 16px 0; background: var(--silk); }
.result {
  padding: 8px 16px 4px;
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 22px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: min(340px, 50vh);
  overflow: auto;
  overscroll-behavior: contain;
}
.result.is-error { color: var(--danger); font-size: 13px; line-height: 20px; }
.card-foot { display: flex; align-items: center; gap: 2px; padding: 4px 8px 8px; }
/* Streaming cursor: a short gold thread that blinks. */
.caret {
  display: inline-block;
  width: 10px;
  height: 2px;
  margin-left: 3px;
  vertical-align: baseline;
  border-radius: 1px;
  background: var(--silk);
  animation: blink 1s steps(2, start) infinite;
}
/* Loading: a gold thread sweeping left to right. */
.loader {
  position: relative;
  height: 2px;
  margin: 12px 0 10px;
  overflow: hidden;
  border-radius: 1px;
  background: var(--silk-soft);
}
.loader::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--silk), transparent);
  animation: sweep 1.2s var(--ease-silk) infinite;
}

@keyframes rise-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes card-in { from { opacity: 0; transform: scale(0.96); } }
@keyframes blink { to { visibility: hidden; } }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@keyframes silk-gather {
  0% { opacity: 1; stroke-dashoffset: 0; }
  70% { opacity: 1; stroke-dasharray: 0.01 120; stroke-dashoffset: -106.8; }
  100% { opacity: 0; stroke-dasharray: 0.01 120; stroke-dashoffset: -106.8; }
}
@keyframes fade-in { from { opacity: 0; } }
/* Reduced motion: no movement or scaling, at most a 120 ms fade; the loader stands still. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
  .hud, .card, .trigger { animation: fade-in var(--dur-fast) linear !important; }
  .loader::after { left: 30%; }
}
`
