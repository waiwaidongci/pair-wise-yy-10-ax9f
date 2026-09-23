/*
 * kanban.js — 看板交互层
 *
 * 职责：所有 DOM 渲染与用户操作。
 * - 作品看板：贴线中/待阴干/上金粉/待交付 四列流转（转「待交付」前做返工放行校验）。
 * - 补线工位看板：待备料 / 已排期 / 返工中 / 待复核 / 已放行 / 旧令留档 六列。
 * - 返工令开具、材料备齐、开工、完成、他人复核、驳回、派工更正（旧令归档）。
 * 所有排期文字都来自 scheduler 重算结果，刷新即与作品履历对齐。
 */
(function () {
  "use strict";

  const M = window.WorkshopModel;
  const S = window.WorkshopScheduler;

  const WORK_STATUSES = ["贴线中", "待阴干", "上金粉", "待交付"];
  const today = M.todayStr;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function confirmBox(msg) { return window.confirm(msg); }
  function alertBox(msg) { window.alert(msg); }

  let themeFilterEl, statusFilterEl, sortModeEl;
  let workForm, boardEl, detailDialog;

  // ---------- 作品看板 ----------
  function filteredWorks() {
    const works = M.listWorks();
    return works
      .filter(w => !statusFilterEl.value || w.status === statusFilterEl.value)
      .filter(w => !themeFilterEl.value || w.theme.includes(themeFilterEl.value.trim()))
      .sort((a, b) => (a[sortModeEl.value] || "").localeCompare(b[sortModeEl.value] || ""));
  }

  function workBadge(w) {
    const active = M.activeOrderOfWork(w.id);
    if (active) return ` <span class="tag tag-rw">返工 ${esc(active.orderNo)}</span>`;
    const past = M.ordersOfWork(w.id).filter(o => o.status === M.ORDER_STATUS.ARCHIVED);
    if (past.length) return ` <span class="tag tag-arch">曾返工</span>`;
    return "";
  }

  function renderSummaries() {
    const works = M.listWorks();
    const todayDry = works.filter(w => w.dryDate <= today() && w.status === "待阴干");
    const defects = works.filter(w => w.defect);
    const delivery = [...works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);

    $("#todayDry").innerHTML = todayDry.length ? todayDry.map(w =>
      `<div class="item" onclick="WorkshopKanban.showWork('${w.id}')"><b>${esc(w.theme)}</b><div class="meta">${esc(w.base)} · ${esc(w.dryDate)}</div></div>`
    ).join("") : `<div class="empty">暂无</div>`;

    $("#defectList").innerHTML = defects.length ? defects.map(w => {
      const active = M.activeOrderOfWork(w.id);
      return `<div class="item overdue" onclick="WorkshopKanban.showWork('${w.id}')">
        <b>${esc(w.theme)}</b>${active ? ` <span class="tag tag-rw">${esc(active.orderNo)}</span>` : ` <span class="tag tag-new">可开返工令</span>`}
        <div class="meta">${esc(w.defect)}</div></div>`;
    }).join("") : `<div class="empty">暂无</div>`;

    $("#deliveryList").innerHTML = delivery.map(w =>
      `<div class="item" onclick="WorkshopKanban.showWork('${w.id}')"><b>${esc(w.theme)}</b><div class="meta">${esc(w.delivery)} · ${esc(w.status)}</div></div>`
    ).join("");
  }

  function renderWorkBoard() {
    const list = filteredWorks();
    boardEl.innerHTML = WORK_STATUSES.map(status => {
      const cards = list.filter(w => w.status === status);
      return `<section class="col">
        <h3><span>${status}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(w => `<article class="item ${w.defect ? "overdue" : ""}" onclick="WorkshopKanban.showWork('${w.id}')">
          <b>${esc(w.theme)}</b>${workBadge(w)}
          <div class="meta">${esc(w.base)} · ${esc(w.line)}<br>进度 ${w.progress}% · 阴干 ${esc(w.dryDate)}<br>金粉：${esc(w.gold)} · 交付：${esc(w.delivery)}<br>缺陷：${esc(w.defect || "无")}</div>
          <div class="actions" onclick="event.stopPropagation()">
            ${WORK_STATUSES.map(s => `<button class="${s === status ? "secondary" : ""}" onclick="WorkshopKanban.setWorkStatus('${w.id}', '${s}')">${s}</button>`).join("")}
            <button class="warn" onclick="WorkshopKanban.recordDefect('${w.id}')">记缺陷</button>
          </div>
        </article>`).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  function setWorkStatus(id, status) {
    if (status === "待交付") {
      const check = M.canDeliver(id);
      if (!check.ok) { alertBox("不能转入待交付：" + check.reason); return; }
    }
    M.updateWorkStatus(id, status);
    renderAll();
  }

  function recordDefect(id, text) {
    const value = text || window.prompt("输入断线/翘线位置");
    if (!value) return;
    M.recordDefect(id, value.trim());
    renderAll();
  }

  function showWork(id) {
    const w = M.getWork(id);
    if (!w) return;
    $("#detailTitle").textContent = w.theme + " · " + w.base;
    const mine = M.ordersOfWork(id);
    $("#detailContent").innerHTML = `
      胎体材质：${esc(w.base)}<br>线条粗细：${esc(w.line)}<br>贴线进度：${w.progress}%<br>
      阴干日期：${esc(w.dryDate)}<br>金粉状态：${esc(w.gold)}<br>缺陷位置：${esc(w.defect || "无")}<br>
      交付日期：${esc(w.delivery)}<br>当前状态：${esc(w.status)}<br>备注：${esc(w.note || "无")}<br>
      返工履历：${mine.length ? mine.map(o => esc(o.orderNo) + "（" + esc(o.status) + (o.reviewStatus === M.REVIEW_STATUS.DONE ? "·已复核" : "") + "）").join("，") : "无"}<br>
      流转记录：<br>${w.logs.map(l => "· " + esc(l.time) + " " + esc(l.text)).join("<br>")}
    `;
    $("#workIdForOrder").value = id;
    $("#saveDefect").dataset.id = id;
    detailDialog.showModal();
  }

  // ---------- 返工令表单（开具 / 更正） ----------
  let orderDialog = $("#orderDialog");
  let materialEditor = $("#materialEditor");
  let reviseTargetId = null; // 非空表示更正模式

  function materialRowHtml(name, quantity, prepared) {
    return `<div class="mat-row">
      <input class="mat-name" placeholder="材料名，如 朱红漆线（细）" value="${esc(name || "")}">
      <input class="mat-qty" placeholder="用量" value="${esc(quantity || "")}">
      <label class="mat-prep"><input type="checkbox" class="mat-ready" ${prepared ? "checked" : ""}>备齐</label>
      <button type="button" class="secondary mat-del" title="删除材料">×</button>
    </div>`;
  }

  function addMaterialRow(name, quantity, prepared) {
    materialEditor.insertAdjacentHTML("beforeend", materialRowHtml(name, quantity, prepared));
  }

  function openCreateOrder(workId) {
    const id = workId || $("#workIdForOrder").value;
    const w = M.getWork(id);
    if (!w) { alertBox("请先选择缺陷作品"); return; }
    if (!w.defect) { alertBox("只有登记了缺陷的作品才能开具返工令"); return; }
    if (M.activeOrderOfWork(id)) {
      alertBox("该作品已有一张未完结返工令；如需改动请用「更正」，旧令会自动留档。");
      return;
    }
    reviseTargetId = null;
    $("#orderDialogTitle").textContent = "开具返工令 · " + w.theme;
    $("#orderProcess").value = "贴线";
    $("#orderOperator").value = "";
    $("#orderPromised").value = today();
    $("#orderWorkRef").textContent = w.theme + "（" + w.base + "）缺陷：" + w.defect;
    materialEditor.innerHTML = "";
    addMaterialRow("", "", false);
    orderDialog.showModal();
  }

  function openReviseOrder(orderId) {
    const o = M.getOrder(orderId);
    if (!o || o.status === M.ORDER_STATUS.ARCHIVED) return;
    if (!confirmBox("更正任一派工字段都会使旧排期与放行结论失效，旧令留档并另立新令，是否继续？")) return;
    reviseTargetId = orderId;
    const w = M.getWork(o.workId);
    $("#orderDialogTitle").textContent = "更正返工令 " + o.orderNo;
    $("#orderProcess").value = o.responsibleProcess;
    $("#orderOperator").value = o.operator;
    $("#orderPromised").value = o.promisedCompletionDate;
    $("#orderWorkRef").textContent = (w ? w.theme + "（" + w.base + "）" : "") + " 缺陷：" + (w ? w.defect : "");
    materialEditor.innerHTML = "";
    o.materials.forEach(m => addMaterialRow(m.name, m.quantity, m.prepared));
    orderDialog.showModal();
  }

  function collectOrderDraft() {
    const materials = $all(".mat-row", materialEditor).map(row => ({
      name: $(".mat-name", row).value.trim(),
      quantity: $(".mat-qty", row).value.trim(),
      prepared: $(".mat-ready", row).checked
    })).filter(m => m.name);
    return {
      responsibleProcess: $("#orderProcess").value,
      operator: $("#orderOperator").value,
      promisedCompletionDate: $("#orderPromised").value,
      materials
    };
  }

  function submitOrderForm() {
    const draft = collectOrderDraft();
    try {
      if (reviseTargetId) {
        M.reviseOrder(reviseTargetId, draft);
      } else {
        const workId = $("#workIdForOrder").value;
        M.createOrder(workId, draft);
      }
      orderDialog.close();
      renderAll();
    } catch (e) {
      alertBox(e.message || String(e));
    }
  }

  // ---------- 复核对话框 ----------
  let reviewDialog = $("#reviewDialog");
  let reviewOrderId = null;

  function openReview(orderId) {
    reviewOrderId = orderId;
    const o = M.getOrder(orderId);
    $("#reviewRef").textContent = o.orderNo + " · 操作者：" + o.operator + "（复核人须为另一人）";
    $("#reviewerName").value = "";
    $("#reviewReason").value = "";
    reviewDialog.showModal();
  }
  function submitReview(pass) {
    const reviewer = $("#reviewerName").value.trim();
    const reason = $("#reviewReason").value.trim();
    try {
      if (pass) M.reviewOrder(reviewOrderId, reviewer);
      else M.rejectReview(reviewOrderId, reviewer, reason);
      reviewDialog.close();
      renderAll();
    } catch (e) {
      alertBox(e.message || String(e));
    }
  }

  // ---------- 补线工位看板 ----------
  const PHASES = [
    { key: "blocked", title: "待备料", cls: "col-amber" },
    { key: "scheduled", title: "已排期", cls: "col-teal" },
    { key: "working", title: "返工中", cls: "col-blue" },
    { key: "pendingReview", title: "待复核", cls: "col-violet" },
    { key: "released", title: "已放行", cls: "col-green" },
    { key: "archived", title: "旧令留档", cls: "col-gray" }
  ];

  function cardActions(phase, o) {
    const id = o.id;
    switch (phase) {
      case "blocked":
        return o.materials.map(m =>
          `<button class="${m.prepared ? "secondary" : "warn"}" onclick="WorkshopKanban.toggleMaterial('${id}','${m.id}')">${m.prepared ? "✓ " : "备 "}${esc(m.name)}</button>`
        ).join("") + `<button class="violet" onclick="WorkshopKanban.revise('${id}')">更正</button>`;
      case "scheduled":
        return `<button onclick="WorkshopKanban.start('${id}')">开工</button>
                <button class="violet" onclick="WorkshopKanban.revise('${id}')">更正</button>`;
      case "working":
        return `<button onclick="WorkshopKanban.complete('${id}')">完成返工</button>
                <button class="violet" onclick="WorkshopKanban.revise('${id}')">更正</button>`;
      case "pendingReview":
        return `<button class="secondary" onclick="WorkshopKanban.openReview('${id}')">他人复核</button>
                <button class="violet" onclick="WorkshopKanban.revise('${id}')">更正</button>`;
      case "released":
        return `<button class="secondary" onclick="WorkshopKanban.toDelivery('${id}')">转待交付</button>
                <button class="violet" onclick="WorkshopKanban.revise('${id}')">更正</button>`;
      case "archived":
        return `<button class="secondary" onclick="WorkshopKanban.viewOrder('${id}')">查看留档</button>`;
      default:
        return "";
    }
  }

  function orderCard(row) {
    const o = row.order;
    const w = M.getWork(o.workId) || { theme: "（作品已删）", base: "", delivery: "—" };
    const mats = o.materials.map(m =>
      `<span class="mat ${m.prepared ? "mat-ok" : "mat-no"}">${m.prepared ? "✓" : "✗"} ${esc(m.name)}${m.quantity ? " " + esc(m.quantity) : ""}</span>`
    ).join(" ");
    const sched = row.scheduledDate
      ? (row.overflow
          ? `排期 <b>${esc(row.scheduledDate)}</b> <span class="tag tag-warn">顺延</span>`
          : `排期 <b>${esc(row.scheduledDate)}</b>`)
      : (row.phase === "blocked" ? `<span class="tag tag-warn">未入排期</span>` : "");
    return `<article class="item rw-card ${row.overflow ? "overdue" : ""}">
      <div class="rw-head"><b>${esc(o.orderNo)}</b><span class="meta">${esc(o.responsibleProcess)}</span></div>
      <div class="meta">
        <b>${esc(w.theme)}</b> · ${esc(w.base)}<br>
        操作者：${esc(o.operator)} · 交付：${esc(w.delivery)}<br>
        承诺完成：${esc(o.promisedCompletionDate)}<br>
        ${sched}
      </div>
      <div class="mats">${mats}</div>
      <div class="reason">${esc(row.reason || "")}</div>
      ${o.reviewStatus === M.REVIEW_STATUS.DONE ? `<div class="meta">复核：${esc(o.reviewer)} · ${esc((o.reviewedAt || "").toString())}</div>` : ""}
      <div class="actions">${cardActions(row.phase, o)}</div>
    </article>`;
  }

  function renderReworkBoard() {
    const result = S.recompute();
    const rowsByPhase = {};
    PHASES.forEach(p => rowsByPhase[p.key] = []);

    result.rows.forEach(r => {
      const o = M.getOrder(r.orderId);
      if (!o) return;
      let phase = r.phase;
      if (phase === "scheduled" && o.startedAt) phase = "working";
      if (!rowsByPhase[phase]) rowsByPhase[phase] = [];
      rowsByPhase[phase].push({ ...r, order: o });
    });

    // 列内排序：已排期/返工中按排期日，待复核按完成时间，留档按时间倒序
    ["scheduled", "working"].forEach(k =>
      rowsByPhase[k].sort((a, b) => (a.scheduledDate || "9999").localeCompare(b.scheduledDate || "9999")));
    rowsByPhase.pendingReview.sort((a, b) => (a.order.completedAt || "").localeCompare(b.order.completedAt || ""));
    rowsByPhase.archived.sort((a, b) => (b.order.updatedAt || "").localeCompare(a.order.updatedAt || ""));

    $("#reworkBoard").innerHTML = PHASES.map(p => {
      const rows = rowsByPhase[p.key];
      const extra = p.key === "blocked"
        ? rows.reduce((n, r) => n + r.materialPending.length, 0)
        : rows.length;
      return `<section class="col ${p.cls}">
        <h3><span>${p.title}</span><span>${p.key === "blocked" ? rows.length + "令/" + extra + "料" : rows.length}</span></h3>
        ${rows.length ? rows.map(orderCard).join("") : `<div class="empty">暂无</div>`}
      </section>`;
    }).join("");

    renderCapacity(result);
  }

  function renderCapacity(result) {
    // 未来 5 天各工序容量
    const dates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today() + "T00:00:00");
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    $("#capacityBar").innerHTML = dates.map(d => {
      const cells = M.PROCESSES.map(p => {
        const c = S.capacityOf(result, p, d);
        const full = c.remaining === 0;
        return `<span class="cap ${full ? "cap-full" : c.remaining <= 1 ? "cap-near" : ""}" title="${p} ${d}">${esc(p.slice(0, 2))} ${c.used}/${c.cap}</span>`;
      }).join("");
      return `<div class="cap-day"><span class="cap-date">${d === today() ? "今天" : esc(d.slice(5))}</span>${cells}</div>`;
    }).join("");
  }

  // ---------- 返工令动作 ----------
  function toggleMaterial(orderId, materialId) {
    try { M.toggleMaterial(orderId, materialId); renderAll(); }
    catch (e) { alertBox(e.message); }
  }
  function start(id) {
    try { M.startRework(id); renderAll(); } catch (e) { alertBox(e.message); }
  }
  function complete(id) {
    try {
      M.completeRework(id);
      renderAll();
    } catch (e) { alertBox(e.message); }
  }
  function toDelivery(orderId) {
    const o = M.getOrder(orderId);
    if (!o) return;
    const check = M.canDeliver(o.workId);
    if (!check.ok) { alertBox("不能转待交付：" + check.reason); return; }
    M.updateWorkStatus(o.workId, "待交付");
    M.appendWorkLog(o.workId, o.orderNo + " 复核放行后转入待交付");
    renderAll();
  }
  function viewOrder(id) {
    const o = M.getOrder(id);
    const w = M.getWork(o.workId);
    $("#detailTitle").textContent = "返工令 " + o.orderNo + (o.status === M.ORDER_STATUS.ARCHIVED ? "（已留档）" : "");
    $("#detailContent").innerHTML = `
      作品：${w ? esc(w.theme) + " · " + esc(w.base) : "—"}<br>
      责任工序：${esc(o.responsibleProcess)}<br>
      操作者：${esc(o.operator)}<br>
      复核人：${o.reviewer ? esc(o.reviewer) : "未复核"}<br>
      承诺完成日：${esc(o.promisedCompletionDate)}<br>
      补线材料：<br>${o.materials.map(m => "· " + (m.prepared ? "✓" : "✗") + " " + esc(m.name) + " " + esc(m.quantity)).join("<br>")}<br>
      状态：${esc(o.status)} / ${esc(o.reviewStatus)}<br>
      ${o.revisionOf ? "由旧令更正新立" : ""}
      日志：<br>${o.logs.map(l => "· " + esc(l.time) + " " + esc(l.text)).join("<br>")}
    `;
    $("#workIdForOrder").value = o.workId;
    detailDialog.showModal();
  }

  // ---------- 总渲染 ----------
  function renderAll() {
    renderSummaries();
    renderWorkBoard();
    renderReworkBoard();
  }

  // ---------- 初始化 ----------
  function init() {
    M.load();

    workForm = $("#workForm");
    boardEl = $("#board");
    detailDialog = $("#detailDialog");
    themeFilterEl = $("#themeFilter");
    statusFilterEl = $("#statusFilter");
    sortModeEl = $("#sortMode");

    statusFilterEl.innerHTML = `<option value="">全部状态</option>` +
      WORK_STATUSES.map(s => `<option>${s}</option>`).join("");
    $("#orderProcess").innerHTML = M.PROCESSES.map(p => `<option>${p}</option>`).join("");

    const dry = $("#workForm [name=dryDate]");
    const del = $("#workForm [name=delivery]");
    if (dry) dry.value = today();
    if (del) del.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    workForm.addEventListener("submit", ev => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(workForm).entries());
      M.addWork(data);
      workForm.reset();
      if (dry) dry.value = today();
      if (del) del.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      renderAll();
    });

    $("#saveDefect").addEventListener("click", () => {
      const id = $("#saveDefect").dataset.id || $("#workIdForOrder").value;
      const v = $("#defectInput").value.trim();
      if (v) { recordDefect(id, v); }
      detailDialog.close();
      renderAll();
    });
    $("#closeDialog").addEventListener("click", () => detailDialog.close());
    $("#openCreateOrder").addEventListener("click", () => openCreateOrder());
    $("#addMaterial").addEventListener("click", () => addMaterialRow("", "", false));
    materialEditor.addEventListener("click", ev => {
      if (ev.target.classList.contains("mat-del")) ev.target.closest(".mat-row").remove();
    });
    $("#orderCancel").addEventListener("click", () => orderDialog.close());
    $("#orderSubmit").addEventListener("click", submitOrderForm);
    $("#reviewPass").addEventListener("click", () => submitReview(true));
    $("#reviewReject").addEventListener("click", () => submitReview(false));
    $("#reviewCancel").addEventListener("click", () => reviewDialog.close());

    $("#clearFilters").addEventListener("click", () => {
      themeFilterEl.value = ""; statusFilterEl.value = ""; renderAll();
    });
    [statusFilterEl, themeFilterEl, sortModeEl].forEach(el => el.addEventListener("input", renderAll));

    $("#refreshBtn").addEventListener("click", renderAll);
    $("#exportBtn").addEventListener("click", () => {
      const payload = { works: M.listWorks(), reworkOrders: M.listOrders() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "lacquer-thread-workshop.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });
    $("#resetBtn").addEventListener("click", () => {
      if (confirmBox("将清空本地数据并恢复演示数据，确定？")) { M.resetAll(); renderAll(); }
    });

    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);

  window.WorkshopKanban = {
    showWork, setWorkStatus, recordDefect,
    toggleMaterial, start, complete, openReview,
    revise: openReviseOrder, toDelivery, viewOrder
  };
})();
