#!/usr/bin/env bash
set -euo pipefail

BROWSER_LIB="/paperclip/instances/default/projects/1326235e-8321-42b2-9c4d-02944611ec34/66aa5a9e-58e5-4540-91f2-582ac8f98075/_default/artifacts/elea-74/browser-root/usr/lib/x86_64-linux-gnu"
CHROME="/paperclip/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
FONTS_DIR="/paperclip/instances/default/projects/1326235e-8321-42b2-9c4d-02944611ec34/66aa5a9e-58e5-4540-91f2-582ac8f98075/_default/artifacts/elea-74/local-fonts.conf"
OUT_DIR="$(dirname "$0")/../docs/screenshots"
export TMP_DIR="$(mktemp -d)"

export LD_LIBRARY_PATH="$BROWSER_LIB"
export FONTCONFIG_FILE="$FONTS_DIR"

screenshot() {
  local html_file="$1"
  local out_file="$2"
  "$CHROME" \
    --no-sandbox \
    --headless \
    --disable-gpu \
    --window-size=1280,900 \
    --screenshot="$out_file" \
    --virtual-time-budget=3000 \
    "file://$html_file" 2>/dev/null
  echo "Saved: $out_file"
}

# Generate HTML files via Node.js then screenshot them
node --input-type=module << 'JSEOF'
import { writeFileSync } from 'fs';

const NAV = `
<nav style="background:white;border-bottom:1px solid #eee;padding:0 24px;display:flex;align-items:center;height:56px;gap:4px;">
  <span style="font-weight:700;font-size:16px;margin-right:20px;color:#111;">&#9650; Elevation</span>
  <span style="padding:8px 14px;color:#0066ff;font-size:14px;border-radius:4px;font-weight:600;background:#f0f5ff;">Overview</span>
  <span style="padding:8px 14px;color:#666;font-size:14px;border-radius:4px;">Agents</span>
  <span style="padding:8px 14px;color:#666;font-size:14px;border-radius:4px;">Teams</span>
  <span style="padding:8px 14px;color:#666;font-size:14px;border-radius:4px;">Budgets</span>
  <span style="padding:8px 14px;color:#666;font-size:14px;border-radius:4px;">Alerts</span>
  <span style="padding:8px 14px;color:#666;font-size:14px;border-radius:4px;">Tool Calls</span>
</nav>`;

const FOOTER = `
<footer style="border-top:1px solid #eee;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#999;margin-top:24px;">
  <span>Elevation Networks</span><span>elevationnetworks.net</span>
</footer>`;

// ── Overview Page ──────────────────────────────────────────────────────────

const overviewHTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; }</style>
</head><body>
${NAV.replace('Overview</span>', 'Overview</span>').replace(
  '>Agents<', ' style="color:#666;">Agents<'
)}
<div style="padding:24px;">
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">
    <h1 style="font-size:24px;font-weight:700;">Overview</h1>
    <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#00c9a7;">
      <div style="width:8px;height:8px;border-radius:50%;background:#00c9a7;"></div>Live
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;">
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #ddd;background:white;color:#333;font-size:13px;">1d</span>
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #0066ff;background:#0066ff;color:white;font-size:13px;font-weight:600;">7d</span>
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #ddd;background:white;color:#333;font-size:13px;">30d</span>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px;">
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Total Spend</div>
      <div style="font-size:28px;font-weight:700;color:#111;">$284.3812</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Requests</div>
      <div style="font-size:28px;font-weight:700;color:#111;">14,827</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Input Tokens</div>
      <div style="font-size:28px;font-weight:700;color:#111;">38,492,103</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Output Tokens</div>
      <div style="font-size:28px;font-weight:700;color:#111;">9,183,446</div>
    </div>
  </div>

  <!-- Cost trend SVG chart -->
  <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;margin-bottom:24px;">
    <div style="font-size:15px;color:#555;font-weight:600;margin-bottom:16px;">Cost Trend (7d)</div>
    <svg width="100%" height="200" viewBox="0 0 1200 200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0066ff" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#0066ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <!-- Grid lines -->
      <line x1="0" y1="160" x2="1200" y2="160" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="120" x2="1200" y2="120" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="80" x2="1200" y2="80" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="40" x2="1200" y2="40" stroke="#f0f0f0" stroke-width="1"/>
      <!-- Y axis labels -->
      <text x="0" y="164" font-size="11" fill="#999">$0</text>
      <text x="0" y="124" font-size="11" fill="#999">$15</text>
      <text x="0" y="84" font-size="11" fill="#999">$30</text>
      <text x="0" y="44" font-size="11" fill="#999">$45</text>
      <!-- Area fill: data points scaled, June 12-19: 28,34,41,38,52,44,39,8 -->
      <path d="M 50,108 C 100,108 120,82 220,68 C 320,54 340,62 440,98 C 540,35 580,35 640,52 C 700,68 720,74 820,68 C 900,62 940,68 1150,155 L 1150,170 L 50,170 Z" fill="url(#g1)"/>
      <path d="M 50,108 C 100,108 120,82 220,68 C 320,54 340,62 440,98 C 540,35 580,35 640,52 C 700,68 720,74 820,68 C 900,62 940,68 1150,155" fill="none" stroke="#0066ff" stroke-width="2.5"/>
      <!-- Data points -->
      <circle cx="50" cy="108" r="3" fill="#0066ff"/>
      <circle cx="220" cy="68" r="3" fill="#0066ff"/>
      <circle cx="440" cy="98" r="3" fill="#0066ff"/>
      <circle cx="540" cy="35" r="3" fill="#0066ff"/>
      <circle cx="700" cy="68" r="3" fill="#0066ff"/>
      <circle cx="820" cy="68" r="3" fill="#0066ff"/>
      <circle cx="1000" cy="74" r="3" fill="#0066ff"/>
      <circle cx="1150" cy="155" r="3" fill="#0066ff"/>
      <!-- X axis labels -->
      <text x="36" y="190" font-size="11" fill="#999">Jun 12</text>
      <text x="206" y="190" font-size="11" fill="#999">Jun 13</text>
      <text x="426" y="190" font-size="11" fill="#999">Jun 14</text>
      <text x="526" y="190" font-size="11" fill="#999">Jun 15</text>
      <text x="686" y="190" font-size="11" fill="#999">Jun 16</text>
      <text x="806" y="190" font-size="11" fill="#999">Jun 17</text>
      <text x="986" y="190" font-size="11" fill="#999">Jun 18</text>
      <text x="1136" y="190" font-size="11" fill="#999">Jun 19</text>
    </svg>
  </div>

  <!-- Live events feed -->
  <div style="background:white;border:1px solid #eee;border-radius:8px;margin-bottom:24px;overflow:hidden;">
    <div style="padding:12px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px;">
      <div style="width:8px;height:8px;border-radius:50%;background:#00c9a7;"></div>
      <span style="font-size:14px;color:#555;font-weight:600;">Live Cost Events</span>
    </div>
    <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:16px;font-size:12px;align-items:center;">
      <span style="color:#aaa;font-family:monospace;width:70px;">14:38:51</span>
      <span style="font-family:monospace;color:#555;flex:1;">code-review-agent</span>
      <span style="color:#888;width:160px;">claude-sonnet-4-6</span>
      <span style="font-weight:600;color:#0066ff;width:70px;">$0.0214</span>
      <span style="color:#aaa;">2,847&#8593; 441&#8595;</span>
    </div>
    <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:16px;font-size:12px;align-items:center;background:#fafafa;">
      <span style="color:#aaa;font-family:monospace;width:70px;">14:38:44</span>
      <span style="font-family:monospace;color:#555;flex:1;">data-pipeline-bot</span>
      <span style="color:#888;width:160px;">gpt-4o</span>
      <span style="font-weight:600;color:#0066ff;width:70px;">$0.0312</span>
      <span style="color:#aaa;">3,204&#8593; 612&#8595;</span>
    </div>
    <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:16px;font-size:12px;align-items:center;">
      <span style="color:#aaa;font-family:monospace;width:70px;">14:38:31</span>
      <span style="font-family:monospace;color:#555;flex:1;">customer-support-ai</span>
      <span style="color:#888;width:160px;">claude-haiku-4-5</span>
      <span style="font-weight:600;color:#0066ff;width:70px;">$0.0041</span>
      <span style="color:#aaa;">1,887&#8593; 298&#8595;</span>
    </div>
    <div style="padding:8px 16px;display:flex;gap:16px;font-size:12px;align-items:center;background:#fafafa;">
      <span style="color:#aaa;font-family:monospace;width:70px;">14:38:19</span>
      <span style="font-family:monospace;color:#555;flex:1;">code-review-agent</span>
      <span style="color:#888;width:160px;">claude-opus-4-8</span>
      <span style="font-weight:600;color:#0066ff;width:70px;">$0.0831</span>
      <span style="color:#aaa;">4,122&#8593; 1,088&#8595;</span>
    </div>
  </div>

  <!-- Agent table -->
  <div style="background:white;border:1px solid #eee;border-radius:8px;overflow:hidden;">
    <div style="padding:16px;border-bottom:1px solid #eee;font-size:16px;font-weight:600;">Top Agents by Cost</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f9f9f9;">
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Agent ID</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Total Cost</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Requests</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Input Tokens</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Output Tokens</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Avg Cost/Req</th>
          <th style="padding:8px 16px;"></th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:10px 16px;font-size:13px;font-family:monospace;">code-review-agent</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;">$98.2341</td>
          <td style="padding:10px 16px;font-size:13px;">4,891</td>
          <td style="padding:10px 16px;font-size:13px;">13,204,102</td>
          <td style="padding:10px 16px;font-size:13px;">3,147,228</td>
          <td style="padding:10px 16px;font-size:13px;">$0.0201</td>
          <td style="padding:10px 16px;font-size:12px;color:#0066ff;">View &#8594;</td>
        </tr>
        <tr style="border-top:1px solid #eee;background:#fafafa;">
          <td style="padding:10px 16px;font-size:13px;font-family:monospace;">data-pipeline-bot</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;">$72.1807</td>
          <td style="padding:10px 16px;font-size:13px;">3,214</td>
          <td style="padding:10px 16px;font-size:13px;">9,711,044</td>
          <td style="padding:10px 16px;font-size:13px;">2,388,019</td>
          <td style="padding:10px 16px;font-size:13px;">$0.0225</td>
          <td style="padding:10px 16px;font-size:12px;color:#0066ff;">View &#8594;</td>
        </tr>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:10px 16px;font-size:13px;font-family:monospace;">customer-support-ai</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;">$51.4429</td>
          <td style="padding:10px 16px;font-size:13px;">2,877</td>
          <td style="padding:10px 16px;font-size:13px;">7,894,301</td>
          <td style="padding:10px 16px;font-size:13px;">1,901,444</td>
          <td style="padding:10px 16px;font-size:13px;">$0.0179</td>
          <td style="padding:10px 16px;font-size:12px;color:#0066ff;">View &#8594;</td>
        </tr>
        <tr style="border-top:1px solid #eee;background:#fafafa;">
          <td style="padding:10px 16px;font-size:13px;font-family:monospace;">content-generator</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;">$38.9214</td>
          <td style="padding:10px 16px;font-size:13px;">2,103</td>
          <td style="padding:10px 16px;font-size:13px;">5,614,788</td>
          <td style="padding:10px 16px;font-size:13px;">1,388,001</td>
          <td style="padding:10px 16px;font-size:13px;">$0.0185</td>
          <td style="padding:10px 16px;font-size:12px;color:#0066ff;">View &#8594;</td>
        </tr>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:10px 16px;font-size:13px;font-family:monospace;">test-runner-agent</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;">$23.5021</td>
          <td style="padding:10px 16px;font-size:13px;">1,742</td>
          <td style="padding:10px 16px;font-size:13px;">2,067,868</td>
          <td style="padding:10px 16px;font-size:13px;">344,754</td>
          <td style="padding:10px 16px;font-size:13px;">$0.0135</td>
          <td style="padding:10px 16px;font-size:12px;color:#0066ff;">View &#8594;</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
${FOOTER}
</body></html>`;

// ── Budgets Page ───────────────────────────────────────────────────────────

const budgetNav = NAV.replace(
  '>Overview<', ' style="color:#666;">Overview<'
).replace(
  '>Budgets<', ' style="color:#0066ff;font-weight:600;background:#f0f5ff;">Budgets<'
);

const budgetsHTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; }</style>
</head><body>
${budgetNav}
<div style="padding:24px;font-family:system-ui,sans-serif;">
  <div style="display:flex;align-items:center;margin-bottom:24px;">
    <h1 style="font-size:24px;font-weight:700;">Budget Management</h1>
    <span style="margin-left:auto;padding:8px 16px;background:#0066ff;color:white;border-radius:6px;font-size:14px;font-weight:600;">+ New Budget</span>
  </div>
  <div style="background:white;border:1px solid #eee;border-radius:8px;overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f9f9f9;">
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Scope</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Scope ID</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Period</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Limit</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Enforcement</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Current Spend</th>
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Utilization</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#e8f0fe;color:#1a56db;font-size:12px;font-weight:600;">team</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">platform-engineering</td>
          <td style="padding:12px 16px;font-size:13px;">Monthly</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$500.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;font-size:12px;font-weight:600;">kill</span></td>
          <td style="padding:12px 16px;font-size:13px;">$284.3812</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:56.9%;background:#d97706;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#888;">56.9%</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;cursor:pointer;">Delete</span></td>
        </tr>
        <tr style="border-top:1px solid #eee;background:#fafafa;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">agent</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">code-review-agent</td>
          <td style="padding:12px 16px;font-size:13px;">Daily</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$25.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;font-size:12px;font-weight:600;">kill</span></td>
          <td style="padding:12px 16px;font-size:13px;">$14.0334</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:56.1%;background:#d97706;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#888;">56.1%</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;">Delete</span></td>
        </tr>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">agent</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">data-pipeline-bot</td>
          <td style="padding:12px 16px;font-size:13px;">Daily</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$15.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">throttle</span></td>
          <td style="padding:12px 16px;font-size:13px;">$10.3115</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:68.7%;background:#d97706;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#888;">68.7%</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;">Delete</span></td>
        </tr>
        <tr style="border-top:1px solid #eee;background:#fafafa;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">agent</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">customer-support-ai</td>
          <td style="padding:12px 16px;font-size:13px;">Weekly</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$50.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#e8f4fd;color:#1a56db;font-size:12px;font-weight:600;">alert</span></td>
          <td style="padding:12px 16px;font-size:13px;">$12.8607</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:25.7%;background:#0066ff;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#888;">25.7%</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;">Delete</span></td>
        </tr>
        <tr style="border-top:1px solid #eee;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">agent</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">runaway-scraper</td>
          <td style="padding:12px 16px;font-size:13px;">Daily</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$10.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;font-size:12px;font-weight:600;">kill</span></td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;color:#e53e3e;">$10.0521 &#9888;</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:100%;background:#e53e3e;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#e53e3e;font-weight:600;">100.5% - Budget Exceeded</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;">Delete</span></td>
        </tr>
        <tr style="border-top:1px solid #eee;background:#fafafa;">
          <td style="padding:12px 16px;font-size:13px;"><span style="padding:2px 8px;border-radius:4px;background:#e8f0fe;color:#1a56db;font-size:12px;font-weight:600;">team</span></td>
          <td style="padding:12px 16px;font-size:13px;font-family:monospace;">ml-research</td>
          <td style="padding:12px 16px;font-size:13px;">Monthly</td>
          <td style="padding:12px 16px;font-size:13px;font-weight:600;">$200.00</td>
          <td style="padding:12px 16px;"><span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;">throttle</span></td>
          <td style="padding:12px 16px;font-size:13px;">$187.4432</td>
          <td style="padding:12px 16px;min-width:160px;">
            <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:4px;">
              <div style="width:93.7%;background:#e53e3e;height:8px;border-radius:4px;"></div>
            </div>
            <span style="font-size:11px;color:#e53e3e;font-weight:600;">93.7%</span>
          </td>
          <td style="padding:12px 16px;"><span style="padding:4px 10px;color:#e53e3e;border:1px solid #e53e3e;border-radius:4px;font-size:12px;">Delete</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
${FOOTER}
</body></html>`;

// ── Agent Detail Page ──────────────────────────────────────────────────────

const agentDetailHTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; }</style>
</head><body>
${NAV.replace('>Overview<', ' style="color:#666;">Overview<')}
<div style="padding:24px;">
  <div style="margin-bottom:4px;font-size:13px;color:#888;">Agents / code-review-agent</div>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;margin-top:8px;">
    <h1 style="font-size:22px;font-weight:700;font-family:monospace;">code-review-agent</h1>
    <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#00c9a7;">
      <div style="width:8px;height:8px;border-radius:50%;background:#00c9a7;"></div>Live
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;">
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #ddd;background:white;color:#333;font-size:13px;">1d</span>
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #0066ff;background:#0066ff;color:white;font-size:13px;font-weight:600;">7d</span>
      <span style="padding:4px 12px;border-radius:4px;border:1px solid #ddd;background:white;color:#333;font-size:13px;">30d</span>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px;">
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Total Spend</div>
      <div style="font-size:28px;font-weight:700;">$98.2341</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Requests</div>
      <div style="font-size:28px;font-weight:700;">4,891</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Input Tokens</div>
      <div style="font-size:28px;font-weight:700;">13,204,102</div>
    </div>
    <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;">
      <div style="font-size:13px;color:#888;margin-bottom:8px;">Output Tokens</div>
      <div style="font-size:28px;font-weight:700;">3,147,228</div>
    </div>
  </div>

  <!-- Cost trend SVG -->
  <div style="background:white;border:1px solid #eee;border-radius:8px;padding:20px;margin-bottom:24px;">
    <div style="font-size:15px;color:#555;font-weight:600;margin-bottom:16px;">Cost Trend - code-review-agent</div>
    <svg width="100%" height="180" viewBox="0 0 1200 180" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0066ff" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#0066ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="140" x2="1200" y2="140" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="100" x2="1200" y2="100" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="60" x2="1200" y2="60" stroke="#f0f0f0" stroke-width="1"/>
      <line x1="0" y1="20" x2="1200" y2="20" stroke="#f0f0f0" stroke-width="1"/>
      <text x="0" y="155" font-size="11" fill="#999">$0</text>
      <text x="0" y="115" font-size="11" fill="#999">$8</text>
      <text x="0" y="75" font-size="11" fill="#999">$16</text>
      <text x="0" y="35" font-size="11" fill="#999">$24</text>
      <path d="M 50,88 C 120,88 180,46 250,32 C 320,18 380,48 450,118 C 520,18 560,18 640,40 C 720,62 780,62 860,62 C 940,62 980,74 1100,136 L 1100,150 L 50,150 Z" fill="url(#g2)"/>
      <path d="M 50,88 C 120,88 180,46 250,32 C 320,18 380,48 450,118 C 520,18 560,18 640,40 C 720,62 780,62 860,62 C 940,62 980,74 1100,136" fill="none" stroke="#0066ff" stroke-width="2.5"/>
      <circle cx="50" cy="88" r="3" fill="#0066ff"/>
      <circle cx="250" cy="32" r="3" fill="#0066ff"/>
      <circle cx="450" cy="118" r="3" fill="#0066ff"/>
      <circle cx="520" cy="18" r="3" fill="#0066ff"/>
      <circle cx="680" cy="40" r="3" fill="#0066ff"/>
      <circle cx="860" cy="62" r="3" fill="#0066ff"/>
      <circle cx="1000" cy="74" r="3" fill="#0066ff"/>
      <circle cx="1100" cy="136" r="3" fill="#0066ff"/>
      <text x="36" y="170" font-size="11" fill="#999">Jun 12</text>
      <text x="236" y="170" font-size="11" fill="#999">Jun 13</text>
      <text x="436" y="170" font-size="11" fill="#999">Jun 14</text>
      <text x="506" y="170" font-size="11" fill="#999">Jun 15</text>
      <text x="666" y="170" font-size="11" fill="#999">Jun 16</text>
      <text x="846" y="170" font-size="11" fill="#999">Jun 17</text>
      <text x="986" y="170" font-size="11" fill="#999">Jun 18</text>
      <text x="1086" y="170" font-size="11" fill="#999">Jun 19</text>
    </svg>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
    <!-- Live events -->
    <div style="background:white;border:1px solid #eee;border-radius:8px;overflow:hidden;">
      <div style="padding:12px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:50%;background:#00c9a7;"></div>
        <span style="font-size:14px;color:#555;font-weight:600;">Live Cost Events</span>
      </div>
      <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:8px;font-size:12px;align-items:center;">
        <span style="color:#aaa;font-family:monospace;">14:38:51</span>
        <span style="color:#888;flex:1;">claude-sonnet-4-6</span>
        <span style="font-weight:600;color:#0066ff;">$0.0214</span>
        <span style="color:#aaa;">2,847&#8593; 441&#8595;</span>
      </div>
      <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:8px;font-size:12px;align-items:center;background:#fafafa;">
        <span style="color:#aaa;font-family:monospace;">14:38:31</span>
        <span style="color:#888;flex:1;">claude-opus-4-8</span>
        <span style="font-weight:600;color:#0066ff;">$0.0831</span>
        <span style="color:#aaa;">4,122&#8593; 1,088&#8595;</span>
      </div>
      <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:8px;font-size:12px;align-items:center;">
        <span style="color:#aaa;font-family:monospace;">14:37:59</span>
        <span style="color:#888;flex:1;">claude-sonnet-4-6</span>
        <span style="font-weight:600;color:#0066ff;">$0.0177</span>
        <span style="color:#aaa;">2,341&#8593; 389&#8595;</span>
      </div>
      <div style="padding:8px 16px;border-bottom:1px solid #f5f5f5;display:flex;gap:8px;font-size:12px;align-items:center;background:#fafafa;">
        <span style="color:#aaa;font-family:monospace;">14:37:44</span>
        <span style="color:#888;flex:1;">claude-haiku-4-5</span>
        <span style="font-weight:600;color:#0066ff;">$0.0041</span>
        <span style="color:#aaa;">1,887&#8593; 298&#8595;</span>
      </div>
      <div style="padding:8px 16px;display:flex;gap:8px;font-size:12px;align-items:center;">
        <span style="color:#aaa;font-family:monospace;">14:37:22</span>
        <span style="color:#888;flex:1;">claude-sonnet-4-6</span>
        <span style="font-weight:600;color:#0066ff;">$0.0192</span>
        <span style="color:#aaa;">2,541&#8593; 421&#8595;</span>
      </div>
    </div>
    <!-- Model breakdown -->
    <div style="background:white;border:1px solid #eee;border-radius:8px;overflow:hidden;">
      <div style="padding:16px;border-bottom:1px solid #eee;font-size:16px;font-weight:600;">Cost by Model</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f9f9f9;">
            <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Model</th>
            <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Total Cost</th>
            <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Requests</th>
            <th style="padding:8px 16px;text-align:left;font-size:13px;color:#666;font-weight:600;">Avg/Req</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;font-family:monospace;">claude-opus-4-8</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">$61.4812</td>
            <td style="padding:10px 16px;font-size:13px;">1,204</td>
            <td style="padding:10px 16px;font-size:13px;">$0.0511</td>
          </tr>
          <tr style="border-top:1px solid #eee;background:#fafafa;">
            <td style="padding:10px 16px;font-size:12px;font-family:monospace;">claude-sonnet-4-6</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">$34.2917</td>
            <td style="padding:10px 16px;font-size:13px;">3,201</td>
            <td style="padding:10px 16px;font-size:13px;">$0.0107</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;font-family:monospace;">claude-haiku-4-5</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">$2.4612</td>
            <td style="padding:10px 16px;font-size:13px;">486</td>
            <td style="padding:10px 16px;font-size:13px;">$0.0051</td>
          </tr>
        </tbody>
      </table>
      <!-- Mini bar chart using SVG -->
      <div style="padding:16px;">
        <div style="font-size:13px;color:#555;margin-bottom:12px;font-weight:600;">Cost share by model</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
            <span style="width:130px;color:#666;font-family:monospace;font-size:11px;">claude-opus-4-8</span>
            <div style="flex:1;background:#f0f0f0;border-radius:4px;height:10px;">
              <div style="width:62.6%;background:#0066ff;height:10px;border-radius:4px;"></div>
            </div>
            <span style="color:#888;width:36px;text-align:right;">62.6%</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
            <span style="width:130px;color:#666;font-family:monospace;font-size:11px;">claude-sonnet-4-6</span>
            <div style="flex:1;background:#f0f0f0;border-radius:4px;height:10px;">
              <div style="width:34.9%;background:#0066ff;height:10px;border-radius:4px;opacity:0.6;"></div>
            </div>
            <span style="color:#888;width:36px;text-align:right;">34.9%</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
            <span style="width:130px;color:#666;font-family:monospace;font-size:11px;">claude-haiku-4-5</span>
            <div style="flex:1;background:#f0f0f0;border-radius:4px;height:10px;">
              <div style="width:2.5%;background:#0066ff;height:10px;border-radius:4px;opacity:0.4;"></div>
            </div>
            <span style="color:#888;width:36px;text-align:right;">2.5%</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
${FOOTER}
</body></html>`;

const tmpDir = process.env.TMP_DIR;
writeFileSync(tmpDir + '/overview.html', overviewHTML);
writeFileSync(tmpDir + '/budgets.html', budgetsHTML);
writeFileSync(tmpDir + '/agent-detail.html', agentDetailHTML);
console.log('HTML files written to ' + tmpDir);
JSEOF

echo "HTML files generated in $TMP_DIR"

# Screenshot each HTML file
CHROME=/paperclip/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell

screenshot "$TMP_DIR/overview.html" "$OUT_DIR/dashboard-overview.png"
screenshot "$TMP_DIR/budgets.html" "$OUT_DIR/dashboard-budgets.png"
screenshot "$TMP_DIR/agent-detail.html" "$OUT_DIR/dashboard-agent-detail.png"

echo "Optimizing images..."
# Use pngquant or optipng if available for size reduction
for f in "$OUT_DIR"/*.png; do
  if command -v optipng &>/dev/null; then
    optipng -quiet -o2 "$f"
  fi
done

ls -lh "$OUT_DIR"/*.png
echo "Done."
