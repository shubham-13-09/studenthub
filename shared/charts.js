/* ============================================================
   StudentHub — shared dashboard charts (admin, faculty, student)
   Dependency-free: draws plain SVG, so no CDN / internet is needed.
   Text and grid colours come from each panel's CSS variables
   (--ink, --muted, --line), so dark mode works automatically.

   SHCharts.donut(el, slices, opts)   slices: [{label, value, color, text?}]
                                      opts:   {center, sub, empty}
   SHCharts.columns(el, items, opts)  items:  [{label, value, title?, color?}]
                                      opts:   {max, unit, threshold, thresholdLabel, empty}
   SHCharts.line(el, items, opts)     items:  [{label, value, title?}]
                                      opts:   {empty}
   SHCharts.message(el, text)         show a plain message (loading / error)
   ============================================================ */
(function(){
  if(window.SHCharts) return;

  const COLORS = { good: '#18906e', warn: '#e0a23a', bad: '#d1453b', info: '#3b82f6' };

  // ---- styles (injected once, so the three panel CSS files need no change) ----
  const css = `
.sh-chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin:16px 0;}
.sh-chart-grid>.card{margin:0;min-width:0;}
.sh-empty{padding:28px 8px;text-align:center;color:var(--muted);font-size:13px;}
.sh-scroll{overflow-x:auto;}
.sh-scroll svg,.sh-donut svg{display:block;margin:0 auto;height:auto;}
.sh-chart text{font-family:inherit;}
.sh-grid{stroke:var(--line);stroke-width:1;}
.sh-ax{fill:var(--muted);font-size:10px;}
.sh-val{fill:var(--ink);font-size:11px;font-weight:600;}
.sh-th{stroke:#e0a23a;stroke-width:1.3;stroke-dasharray:4 3;}
.sh-bar{transform-box:fill-box;transform-origin:50% 100%;animation:shGrow .55s ease both;}
.sh-arc{animation:shFade .6s ease both;}
.sh-line,.sh-dot{animation:shFade .7s ease both;}
.sh-area{fill:#18906e;opacity:.13;animation:shArea .7s ease both;}
.sh-line{fill:none;stroke:#18906e;stroke-width:2.4;stroke-linejoin:round;stroke-linecap:round;}
.sh-dot{fill:var(--paper);stroke:#18906e;stroke-width:2;}
.sh-cbig{fill:var(--ink);font-size:20px;font-weight:700;}
.sh-csub{fill:var(--muted);font-size:9px;}
.sh-donut{display:flex;align-items:center;justify-content:center;gap:18px;flex-wrap:wrap;}
.sh-legend{list-style:none;display:flex;flex-direction:column;gap:9px;margin:0;padding:0;font-size:13px;color:var(--ink);}
.sh-legend li{display:flex;align-items:center;gap:8px;}
.sh-legend i{width:10px;height:10px;border-radius:3px;flex:none;}
.sh-legend b{margin-left:auto;padding-left:14px;font-weight:600;white-space:nowrap;}
.sh-note{display:flex;align-items:center;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:6px;font-size:11.5px;color:var(--muted);}
.sh-note span{display:inline-flex;align-items:center;gap:6px;}
.sh-note i{width:9px;height:9px;border-radius:3px;background:#d1453b;display:inline-block;}
.sh-note u{width:16px;border-top:2px dashed #e0a23a;display:inline-block;}
@keyframes shGrow{from{transform:scaleY(0);}to{transform:scaleY(1);}}
@keyframes shFade{from{opacity:0;}to{opacity:1;}}
@keyframes shArea{from{opacity:0;}to{opacity:.13;}}
@media (prefers-reduced-motion:reduce){.sh-bar,.sh-arc,.sh-line,.sh-dot,.sh-area{animation:none;}}
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- helpers ----
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // The dashboards refresh every few seconds; if the data did not change, do not redraw (no flicker / re-animation).
  function unchanged(el, data){
    const sig = JSON.stringify(data);
    if(el.dataset.shSig === sig) return true;
    el.dataset.shSig = sig;
    return false;
  }

  function setEmpty(el, text){
    el.innerHTML = `<div class="sh-empty">${esc(text)}</div>`;
  }

  function message(el, text){
    if(!el) return;
    el.dataset.shSig = '';
    setEmpty(el, text);
  }

  function shorten(text, n){
    text = String(text == null ? '' : text);
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  }

  // ---- Donut ----
  function donut(el, slices, opts){
    if(!el) return;
    opts = opts || {};
    slices = slices || [];
    if(unchanged(el, [slices, opts])) return;

    const total = slices.reduce((sum, s) => sum + (s.value || 0), 0);
    if(!total){ setEmpty(el, opts.empty || 'No data yet.'); return; }

    const R = 44, C = 2 * Math.PI * R;
    let acc = 0;
    const arcs = slices.filter(s => s.value > 0).map(s => {
      const len = s.value / total * C;
      const arc = `<circle class="sh-arc" cx="60" cy="60" r="${R}" fill="none" stroke-width="16" stroke="${s.color}"` +
        ` stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}">` +
        `<title>${esc(s.label)}: ${esc(s.text != null ? s.text : s.value)}</title></circle>`;
      acc += len;
      return arc;
    }).join('');

    const center = opts.center != null ? opts.center : total;
    const legend = slices.map(s =>
      `<li><i style="background:${s.color}"></i><span>${esc(s.label)}</span><b>${esc(s.text != null ? s.text : s.value)}</b></li>`
    ).join('');

    el.innerHTML = `<div class="sh-donut sh-chart">
      <svg viewBox="0 0 120 120" width="140" height="140" role="img" aria-label="${esc(opts.label || 'Donut chart')}">
        <circle cx="60" cy="60" r="${R}" fill="none" stroke-width="16" stroke="var(--line)"/>
        <g transform="rotate(-90 60 60)">${arcs}</g>
        <text class="sh-cbig" x="60" y="62" text-anchor="middle">${esc(center)}</text>
        ${opts.sub ? `<text class="sh-csub" x="60" y="76" text-anchor="middle">${esc(opts.sub)}</text>` : ''}
      </svg>
      <ul class="sh-legend">${legend}</ul>
    </div>`;
  }

  // ---- Vertical bars (optional threshold line, e.g. 75% attendance) ----
  function columns(el, items, opts){
    if(!el) return;
    opts = opts || {};
    items = (items || []).filter(i => i && i.value != null);
    if(unchanged(el, [items, opts])) return;
    if(!items.length){ setEmpty(el, opts.empty || 'No data yet.'); return; }

    const unit = opts.unit || '';
    const max = opts.max || Math.max(1, ...items.map(i => i.value));
    const left = 34, right = 12, top = 22, bottom = 40, H = 200;
    const slot = Math.min(90, Math.max(50, (320 - left - right) / items.length));
    const W = left + right + items.length * slot;
    const plotH = H - top - bottom;
    const barW = 28;
    const y = v => top + plotH * (1 - Math.min(v, max) / max);

    let grid = '';
    [0, 0.5, 1].forEach(f => {
      const gy = y(max * f);
      grid += `<line class="sh-grid" x1="${left}" x2="${W - right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"/>` +
              `<text class="sh-ax" x="${left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${Math.round(max * f)}${unit}</text>`;
    });

    const hasTh = opts.threshold != null;
    let bars = '';
    items.forEach((it, i) => {
      const cx = left + i * slot + slot / 2;
      const h = Math.max(it.value > 0 ? 2 : 0, plotH * Math.min(it.value, max) / max);
      const by = top + plotH - h;
      const color = it.color || (hasTh && it.value < opts.threshold ? COLORS.bad : COLORS.good);
      bars += `<g><title>${esc(it.title || it.label)}: ${it.value}${unit}</title>` +
        `<rect class="sh-bar" x="${(cx - barW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="4" fill="${color}" style="animation-delay:${i * 50}ms"/>` +
        `<text class="sh-val" x="${cx.toFixed(1)}" y="${(by - 5).toFixed(1)}" text-anchor="middle">${it.value}${unit}</text>` +
        `<text class="sh-ax" x="${cx.toFixed(1)}" y="${H - bottom + 16}" text-anchor="middle">${esc(shorten(it.label, 9))}</text></g>`;
    });

    let thLine = '';
    if(hasTh){
      const ty = y(opts.threshold).toFixed(1);
      thLine = `<line class="sh-th" x1="${left}" x2="${W - right}" y1="${ty}" y2="${ty}"/>`;
    }

    const anyBelow = hasTh && items.some(i => !i.color && i.value < opts.threshold);
    const note = hasTh
      ? `<div class="sh-note"><span><u></u>${esc(opts.thresholdLabel || ('Min ' + opts.threshold + unit))}</span>` +
        (anyBelow ? `<span><i></i>Below ${opts.threshold}${unit}</span>` : '') + `</div>` : '';

    el.innerHTML = `<div class="sh-chart">
      <div class="sh-scroll"><svg viewBox="0 0 ${W.toFixed(0)} ${H}" style="width:100%;min-width:${items.length > 9 ? Math.round(W) : 0}px;" role="img" aria-label="${esc(opts.label || 'Bar chart')}">
        ${grid}${bars}${thLine}
      </svg></div>${note}</div>`;
  }

  // ---- Line / area chart (e.g. logins per day) ----
  function line(el, items, opts){
    if(!el) return;
    opts = opts || {};
    items = (items || []).filter(i => i && i.value != null);
    if(unchanged(el, [items, opts])) return;
    const total = items.reduce((s, i) => s + i.value, 0);
    if(!items.length || !total){ setEmpty(el, opts.empty || 'No data yet.'); return; }

    const W = 340, H = 200, left = 30, right = 16, top = 26, bottom = 38;
    const plotW = W - left - right, plotH = H - top - bottom;
    const maxV = Math.max(...items.map(i => i.value));
    const yMax = maxV <= 4 ? 4 : Math.ceil(maxV / 4) * 4;
    const n = items.length;
    const x = i => left + (n === 1 ? plotW / 2 : i * plotW / (n - 1));
    const y = v => top + plotH * (1 - v / yMax);

    let grid = '';
    [0, 0.5, 1].forEach(f => {
      const gy = y(yMax * f).toFixed(1);
      grid += `<line class="sh-grid" x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}"/>` +
              `<text class="sh-ax" x="${left - 6}" y="${(parseFloat(gy) + 3).toFixed(1)}" text-anchor="end">${Math.round(yMax * f)}</text>`;
    });

    const pts = items.map((it, i) => [x(i).toFixed(1), y(it.value).toFixed(1)]);
    const path = 'M' + pts.map(p => p.join(',')).join(' L');
    const area = `${path} L${x(n - 1).toFixed(1)},${(top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(top + plotH).toFixed(1)} Z`;

    let marks = '';
    items.forEach((it, i) => {
      marks += `<g><title>${esc(it.title || it.label)}: ${it.value}</title>` +
        `<circle class="sh-dot" cx="${pts[i][0]}" cy="${pts[i][1]}" r="4"/>` +
        `<text class="sh-val" x="${pts[i][0]}" y="${(parseFloat(pts[i][1]) - 9).toFixed(1)}" text-anchor="middle">${it.value}</text>` +
        `<text class="sh-ax" x="${x(i).toFixed(1)}" y="${H - bottom + 16}" text-anchor="middle">${esc(shorten(it.label, 7))}</text></g>`;
    });

    el.innerHTML = `<div class="sh-chart">
      <div class="sh-scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:300px;" role="img" aria-label="${esc(opts.label || 'Line chart')}">
        ${grid}<path class="sh-area" d="${area}"/><path class="sh-line" d="${path}"/>${marks}
      </svg></div></div>`;
  }

  window.SHCharts = { donut, columns, line, message, colors: COLORS };
})();
