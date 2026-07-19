/*
 * 原型共享交互：主题切换 + 运行时调节面板。
 * 页面只需 <script src="_prototype.js" defer></script>，面板自动注入右下角。
 *
 * 调节面板实时覆盖根节点 CSS 变量（圆角/页边距/卡片间距/主色相），
 * 你在浏览器里当场拖动即可预览，满意后把数值告诉我，我再落到真实 token。
 */
(function () {
  const root = document.documentElement;

  // ---- 主题：跟随上次选择（localStorage），默认浅色 ----
  const saved = localStorage.getItem("proto-theme");
  if (saved === "dark") document.body.classList.add("dark");

  function toggleTheme() {
    document.body.classList.toggle("dark");
    localStorage.setItem("proto-theme", document.body.classList.contains("dark") ? "dark" : "light");
    syncThemeLabel();
  }

  // ---- 调节面板 ----
  const panel = document.createElement("div");
  panel.className = "adjust-panel";
  panel.innerHTML = `
    <h4>原型调节</h4>
    <div class="adjust-row">
      <label>圆角 --radius <span data-out="radius">0.70rem</span></label>
      <input type="range" min="0" max="1.6" step="0.05" value="0.7" data-var="--radius" data-unit="rem">
    </div>
    <div class="adjust-row">
      <label>页边距 --page-pad <span data-out="pad">1.50rem</span></label>
      <input type="range" min="0.5" max="3" step="0.1" value="1.5" data-var="--page-pad" data-unit="rem">
    </div>
    <div class="adjust-row">
      <label>卡片间距 --card-gap <span data-out="gap">1.00rem</span></label>
      <input type="range" min="0.4" max="2" step="0.1" value="1" data-var="--card-gap" data-unit="rem">
    </div>
    <div class="adjust-row">
      <label>主色相 hue <span data-out="hue">263</span></label>
      <input type="range" min="0" max="360" step="1" value="263" data-hue>
    </div>
    <div class="adjust-actions">
      <button class="btn btn-outline btn-sm" data-theme-btn>切到深色</button>
      <button class="btn btn-outline btn-sm" data-reset>复位</button>
    </div>
  `;

  const fab = document.createElement("button");
  fab.className = "adjust-fab";
  fab.title = "原型调节";
  fab.textContent = "⚙";
  fab.onclick = () => panel.classList.toggle("open");

  const outs = {};
  function bindOut(el) { const o = el.parentElement.querySelector("[data-out]"); if (o) outs[el.dataset.var || "hue"] = o; }

  function applyVar(el) {
    const v = el.value + (el.dataset.unit || "");
    root.style.setProperty(el.dataset.var, v);
    const o = el.parentElement.querySelector("[data-out]");
    if (o) o.textContent = el.dataset.unit ? Number(el.value).toFixed(2) + el.dataset.unit : el.value;
  }
  function applyHue(el) {
    // 覆盖 light 与 dark 两档主色，仅换色相
    root.style.setProperty("--primary", `oklch(0.546 0.215 ${el.value})`);
    const o = el.parentElement.querySelector("[data-out]");
    if (o) o.textContent = el.value;
  }

  function syncThemeLabel() {
    const b = panel.querySelector("[data-theme-btn]");
    if (b) b.textContent = document.body.classList.contains("dark") ? "切到浅色" : "切到深色";
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    panel.querySelectorAll("input[data-var]").forEach((el) => {
      bindOut(el);
      el.addEventListener("input", () => applyVar(el));
    });
    const hue = panel.querySelector("input[data-hue]");
    hue.addEventListener("input", () => applyHue(hue));
    panel.querySelector("[data-theme-btn]").addEventListener("click", toggleTheme);
    panel.querySelector("[data-reset]").addEventListener("click", () => {
      root.removeAttribute("style");
      panel.querySelectorAll("input").forEach((el) => {
        if (el.dataset.var === "--radius") el.value = 0.7;
        if (el.dataset.var === "--page-pad") el.value = 1.5;
        if (el.dataset.var === "--card-gap") el.value = 1;
        if (el.hasAttribute("data-hue")) el.value = 263;
      });
      panel.querySelectorAll("input[data-var]").forEach(applyVar);
    });
    syncThemeLabel();
  });
})();
