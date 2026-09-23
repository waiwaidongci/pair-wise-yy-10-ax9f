/*
 * kanban.js —— 看板交互层
 * 负责：作品工序看板、补线工位台的渲染与用户操作。
 * 业务不变量来自 models.js，排期判定来自 scheduling.js，本文件不自行实现容量/备料规则。
 */
(function (global) {
  "use strict";

  const { Store, WORK_STATUSES, RESPONSIBLE_PROCESSES, MATERIAL_HINTS, todayStr, WorkshopError } = global.Workshop;
  const S = global.Workshop.scheduling;

  const store = Store.load();
  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, isErr) {
    const el = document.createElement("div");
    if (isErr) el.className = "err";
    el.textContent = msg;
    $("#toast").appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function run(fn) {
    try { fn(); }
    catch (err) {
      if (err instanceof WorkshopError || err.name === "WorkshopError") toast(err.message, true);
      else { console.error(err); toast("操作失败：" + err.message, true); }
    }
  }

  // ============================================================
  // 作品看板
  // ============================================================
  function filteredWorks() {
    const fStatus = $("#statusFilter").value;
    const fTheme = $("#themeFilter").value.trim();
    const sortKey = $("#sortMode").value;
    return store.state.works
      .filter(w => !fStatus || w.status === fStatus)
      .filter(w => !fTheme || w.theme.includes(fTheme))
      .sort((a, b) => (a[sortKey] || "").localeCompare(b[sortKey] || ""));
  }

  function workCard(w) {
    const active = w.activeOrderId ? store.getOrder(w.activeOrderId) : null;
    const orderTag = active
      ? `<span class="badge ${active.status === "待备料" ? "red" : active.status === "待复核" ? "violet" : "amber"}">返工 ${esc(active.id)} · ${esc(active.status)}</span>`
      : (w.defect ? `<span class="badge red">有缺陷未开令</span>` : "");
    return `<article class="item ${w.defect ? "overdue" : ""}">
      <div class="card-head"><b>${esc(w.theme)}</b>${orderTag}</div>
      <div class="meta">${esc(w.base)} · ${esc(w.line)}<br>进度 ${w.progress}% · 阴干 ${esc(w.dryDate)}<br>
      金粉：${esc(w.gold)} · 交付：${esc(w.delivery)}<br>缺陷：${esc(w.defect || "无")}</div>
      <div class="actions" data-work="${w.id}">
        ${WORK_STATUSES.map(s => `<button class="act-status tiny ${s === w.status ? "secondary" : ""}" data-status="${s}" ${s === "待交付" ? "title=\"须复核放行后才能转入\"" : ""}>${s}</button>`).join("")}
        <button class="act-defect warn tiny">记缺陷</button>
        <button class="act-order violet tiny">开返工令</button>
        <button class="act-detail secondary tiny">详情</button>
      </div>
    </article>`;
  }

  function renderBoard() {
    const list = filteredWorks();
    $("#board").innerHTML = WORK_STATUSES.map(status => {
      const cards = list.filter(w => w.status === status);
      return `<section class="col">
        <h3><span>${status}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(workCard).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  function renderSummaries() {
    const t = todayStr();
    const todayDry = store.state.works.filter(w => w.dryDate <= t && w.status === "待阴干");
    const defects = store.state.works.filter(w => w.defect);
    const delivery = [...store.state.works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);
    const mini = (w, extra) => `<div class="item ${w.defect ? "overdue" : ""}" data-work-detail="${w.id}">
      <b>${esc(w.theme)}</b><div class="meta">${esc(w.base)} · ${extra}</div></div>`;
    $("#todayDry").innerHTML = todayDry.length
      ? todayDry.map(w => mini(w, `阴干 ${w.dryDate}`)).join("")
      : `<div class="empty">暂无</div>`;
    $("#defectList").innerHTML = defects.length
      ? defects.map(w => {
          const active = store.findActiveOrder(w.id);
          return mini(w, `${esc(w.defect)}<br>${active
            ? `<span class="badge amber">返工令 ${esc(active.id)} · ${esc(active.status)}</span>`
            : `<span class="badge red">未开返工令</span>`}`);
        }).join("")
      : `<div class="empty">暂无</div>`;
    $("#deliveryList").innerHTML = delivery.map(w => mini(w, `交付 ${w.delivery} · ${esc(w.status)}`)).join("");
  }

  // ============================================================
  // 补线工位台
  // ============================================================
  function orderBrief(o) {
    const w = store.getWork(o.workId);
    return { w, operator: store.operatorName(o.operatorId), ready: S.materialsReady(o) };
  }

  function materialHtml(o, editable) {
    return o.materials.map(m => {
      const ok = m.ready >= m.need;
      if (editable) {
        return `<div class="mat-row">
          <span>${esc(m.name)} 需 ${m.need}${esc(m.unit)}</span>
          <input type="number" min="0" max="${m.need}" step="0.1" value="${m.ready}" data-order="${o.id}" data-line="${m.id}" class="in-ready">
          <span class="badge ${ok ? "" : "red"}">${ok ? "齐" : "缺"}</span>
        </div>`;
      }
      return `<div class="mat-row"><span>${esc(m.name)}：${m.ready}/${m.need}${esc(m.unit)}</span><span class="badge ${ok ? "" : "red"}">${ok ? "齐" : "缺"}</span></div>`;
    }).join("");
  }

  function queueControls(o) {
    const date = $("#planDate").value || todayStr();
    const load = S.dayLoad(store, o.responsibleProcess, date);
    return `<div class="enqueue-row">
      <input class="in-reason" placeholder="排期原因（如：客户加急、明日交付）" value="${esc(o.queue && o.queue.reason !== "按交付日期就近排入" ? o.queue.reason : "")}">
      <button class="act-enqueue tiny" data-order="${o.id}" data-date="${date}">排入 ${esc(date)}（工位 ${load}/3）</button>
    </div>`;
  }

  function orderCard(o, opts = {}) {
    const { w, operator, ready } = orderBrief(o);
    const cls = ["card"];
    if (o.queue && o.queue.state === "bumped") cls.push("bump");
    if (o.status === "待复核") cls.push("review");
    if (o.archived) cls.push("archived");

    let badges = `<span class="badge gray">${esc(o.responsibleProcess)}</span>`;
    if (o.queue) {
      badges += o.queue.state === "scheduled"
        ? `<span class="badge">工位 ${esc(o.queue.targetDate)}</span>`
        : `<span class="badge amber">被挤下 · 候选 ${esc(o.queue.targetDate)}</span>`;
      if (o.queue.invalidated) badges += `<span class="badge red">排期已失效</span>`;
    }
    if (o.release && o.release.result === "pass") badges += `<span class="badge violet">已放行</span>`;
    if (o.release && o.release.invalidated) badges += `<span class="badge red">放行已失效</span>`;
    if (o.supersedes) badges += `<span class="badge gray">更正自 ${esc(o.supersedes)}</span>`;

    const reasonLine = o.queue ? `<div class="reason">排期原因：${esc(o.queue.reason)}</div>` : "";

    let actions = `<button class="act-order-detail tiny secondary" data-order="${o.id}">详情</button>`;
    // 未留档的令（含已完结放行件）都可更正派工；更正后旧排期/放行失效、旧令留档
    if (!o.archived) actions += `<button class="act-revise tiny warn" data-order="${o.id}">更正派工</button>`;
    if (!o.archived && o.status === "已排期") actions += `<button class="act-start tiny" data-order="${o.id}">开工</button>`;
    if (!o.archived && ["已排期", "返工中"].includes(o.status)) actions += `<button class="act-complete tiny" data-order="${o.id}">报完成</button>`;
    if (!o.archived && o.status === "待复核") actions += `<button class="act-review tiny violet" data-order="${o.id}">复核</button>`;

    return `<div class="${cls.join(" ")}">
      <div class="card-head"><b>${esc(w.theme)}</b>${badges}</div>
      <div class="meta">${esc(w.base)} · 缺陷：${esc(w.defect)}<br>
      操作者：${esc(operator)} · 承诺完成：${esc(o.promisedDate)} · 交付：${esc(w.delivery)}</div>
      ${materialHtml(o, !!opts.editableMaterial)}
      ${ready && o.status === "待排期" ? queueControls(o) : ""}
      ${reasonLine}
      <div class="actions">${actions}</div>
    </div>`;
  }

  function renderStation() {
    const date = $("#planDate").value || todayStr();
    $("#planDateLabel").textContent = date;
    const active = store.activeOrders();

    const material = active.filter(o => o.status === "待备料");
    const queued = active.filter(o => o.status === "待排期");
    const review = active.filter(o => o.status === "待复核");
    const done = active.filter(o => o.status === "已完结");

    $("#cnt-mat").textContent = material.length;
    $("#cnt-queue").textContent = queued.length;
    $("#cnt-review").textContent = review.length;
    $("#cnt-done").textContent = done.length;

    $("#colMaterial").innerHTML = material.length
      ? material.map(o => orderCard(o, { editableMaterial: true })).join("")
      : `<div class="empty">材料齐套后自动转入待排期</div>`;
    $("#colQueued").innerHTML = queued.length
      ? queued.map(o => orderCard(o)).join("")
      : `<div class="empty">暂无排队件</div>`;
    $("#colReview").innerHTML = review.length
      ? review.map(o => orderCard(o)).join("")
      : `<div class="empty">暂无待复核件</div>`;
    $("#colDone").innerHTML = done.length
      ? done.map(o => orderCard(o)).join("")
      : `<div class="empty">已完结并放行的返工令</div>`;

    // 工位排期：按工序分块展示当日占用，被挤下的件以提示形式保留原因
    const blocks = RESPONSIBLE_PROCESSES.map(p => {
      const occupied = S.occupiedSlots(store, p, date);
      const bumped = active.filter(o =>
        o.responsibleProcess === p && o.queue && o.queue.targetDate === date &&
        o.queue.state === "bumped" && !o.queue.invalidated);
      const full = occupied.length >= 3;
      return `<div class="process-block ${full ? "full" : ""}">
        <h4><span>${esc(p)}</span><span>${occupied.length}/3 ${full ? "已满" : ""}</span></h4>
        ${occupied.map(o => orderCard(o)).join("") || `<div class="empty">当日无占用</div>`}
        ${bumped.map(o => `<div class="card bump" data-bump-card>
          <div class="card-head"><b>${esc(store.getWork(o.workId).theme)}</b><span class="badge amber">被挤下·原因保留</span></div>
          <div class="reason">${esc(o.queue.reason)}</div>
          ${queueControls(o)}
        </div>`).join("")}
      </div>`;
    }).join("");
    $("#colSlots").innerHTML = blocks;

    // 留档旧令
    const archived = store.state.orders.filter(o => o.archived);
    $("#archiveList").innerHTML = archived.length
      ? `<div class="station-grid">${archived.map(o => {
          const w = store.getWork(o.workId);
          return `<div class="card archived">
            <div class="card-head"><b>${esc(w.theme)}</b><span class="badge gray">旧令 ${esc(o.id)}</span></div>
            <div class="meta">责任工序：${esc(o.responsibleProcess)} · 操作者：${esc(store.operatorName(o.operatorId))}<br>
            续次令：${o.supersededBy ? esc(o.supersededBy) : "—"}</div>
            ${o.queue && o.queue.invalidated ? `<div class="reason">原排期 ${esc(o.queue.targetDate)} 已失效（原因留档：${esc(o.queue.reason)}）</div>` : ""}
            ${o.release && o.release.invalidated ? `<div class="reason">原复核放行结论已失效</div>` : ""}
            <div class="actions"><button class="act-order-detail tiny secondary" data-order="${o.id}">查看履历</button></div>
          </div>`;
        }).join("")}</div>`
      : `<div class="empty">暂无留档旧令</div>`;
  }

  function render() {
    renderSummaries();
    renderBoard();
    renderStation();
  }

  // ============================================================
  // 对话框：作品详情
  // ============================================================
  let activeWorkId = null;
  function showWorkDetail(workId) {
    activeWorkId = workId;
    const w = store.getWork(workId);
    if (!w) return;
    $("#detailTitle").textContent = `${w.theme} · ${w.base}`;
    const chain = store.relatedOrders(workId);
    $("#detailContent").innerHTML = `
      胎体材质：${esc(w.base)}<br>线条粗细：${esc(w.line)} · 贴线进度：${w.progress}%<br>
      阴干日期：${esc(w.dryDate)}<br>金粉状态：${esc(w.gold)}<br>缺陷位置：${esc(w.defect || "无")}<br>
      交付日期：${esc(w.delivery)} · 当前状态：${esc(w.status)}<br>备注：${esc(w.note || "无")}<br>
      返工令：${chain.length ? chain.map(o => `<button class="act-order-detail tiny ${o.archived ? "secondary" : "violet"}" data-order="${o.id}">${esc(o.id)}（${esc(o.status)}${o.archived ? "·留档" : ""}）</button>`).join(" ") : "无"}<br>
      流转记录：${esc(w.logs.join(" / "))}`;
    $("#defectInput").value = "";
    $("#detailDialog").showModal();
  }

  // ============================================================
  // 对话框：开具返工令
  // ============================================================
  let createWorkId = null;

  function matRowHtml(name, unit, need, ready) {
    return `<div class="mat-row" style="flex-wrap:wrap;">
      <input class="mat-name" list="matHint" placeholder="材料名称" value="${esc(name || "")}" style="width:120px;">
      <input class="mat-need" type="number" min="0" step="0.1" placeholder="需求" value="${need ?? ""}" style="width:78px;">
      <input class="mat-ready" type="number" min="0" step="0.1" placeholder="已备" value="${ready ?? 0}" style="width:78px;">
      <input class="mat-unit" placeholder="单位" value="${esc(unit || "")}" style="width:58px;">
      <button type="button" class="mat-del tiny danger">删</button>
    </div>`;
  }

  function fillSelects(scope) {
    const opOpts = store.state.operators.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
    $$(`${scope} select[name="operatorId"]`).forEach(s => s.innerHTML = opOpts);
    $$(`${scope} select[name="reviewerId"]`).forEach(s => s.innerHTML = opOpts);
    $$(`${scope} select[name="responsibleProcess"]`).forEach(s =>
      s.innerHTML = RESPONSIBLE_PROCESSES.map(p => `<option>${p}</option>`).join(""));
  }

  function openCreateOrder(workId) {
    const w = store.getWork(workId);
    const check = store.canCreateOrder(workId);
    if (!check.ok) return toast(check.reason, true);
    createWorkId = workId;
    $("#orderCreateWork").innerHTML = `作品：<b>${esc(w.theme)}</b>（${esc(w.base)}） · 缺陷：${esc(w.defect)} · 交付：${esc(w.delivery)}`;
    fillSelects("#orderCreateDialog");
    $("#orderCreateForm").promisedDate.value = w.delivery;
    $("#createMatRows").innerHTML = matRowHtml("漆线", "米", 1, 0);
    $("#orderCreateDialog").showModal();
  }

  function readMaterials(container) {
    return $$(".mat-row", container).map(row => ({
      name: $(".mat-name", row).value.trim(),
      need: Number($(".mat-need", row).value),
      ready: Number($(".mat-ready", row).value) || 0,
      unit: $(".mat-unit", row).value.trim()
    })).filter(m => m.name);
  }

  // ============================================================
  // 对话框：返工令详情 / 复核 / 更正
  // ============================================================
  function showOrderDetail(orderId) {
    const o = store.getOrder(orderId);
    if (!o) return;
    const w = store.getWork(o.workId);
    $("#orderDetailTitle").textContent = `返工令 ${o.id}（第 ${o.revision} 次派工）`;
    const release = o.release
      ? `复核：${o.release.result === "pass" ? "通过放行" : "不通过退回"} · 复核人 ${esc(store.operatorName(o.release.reviewerId))}${o.release.invalidated ? " <b>（已失效）</b>" : ""} · 意见：${esc(o.release.comment || "无")}`
      : "复核：尚未复核";
    $("#orderDetailContent").innerHTML = `
      作品：<b>${esc(w.theme)}</b>（${esc(w.base)}） · 交付 ${esc(w.delivery)}<br>
      缺陷：${esc(w.defect)}<br>
      责任工序：${esc(o.responsibleProcess)} · 状态：<b>${esc(o.status)}</b>${o.archived ? "（已留档作废）" : ""}<br>
      操作者：${esc(store.operatorName(o.operatorId))} · 承诺完成日：${esc(o.promisedDate)}<br>
      补线材料：${o.materials.map(m => `${esc(m.name)} ${m.ready}/${m.need}${esc(m.unit)}`).map(esc).join("；")}<br>
      排期：${o.queue ? `${esc(o.queue.targetDate)} · ${o.queue.state === "scheduled" ? "已获得工位" : "被挤下"} · ${o.queue.invalidated ? "<b>结论已失效</b> · " : ""}原因：${esc(o.queue.reason)}` : "未排期"}<br>
      ${release}<br>
      前序令：${o.supersedes ? esc(o.supersedes) : "无"} · 续次令：${o.supersededBy ? esc(o.supersededBy) : "无"}`;

    // 沿 supersede 链把新旧令履历串成作品履历
    let first = o;
    while (first.supersedes) {
      const prev = store.getOrder(first.supersedes);
      if (!prev) break;
      first = prev;
    }
    const chain = [];
    let cur = first;
    while (cur) {
      chain.push(cur);
      cur = cur.supersededBy ? store.getOrder(cur.supersededBy) : null;
    }
    $("#orderTimeline").innerHTML =
      chain.map(co => `<div><b>${esc(co.id)}${co.archived ? "（留档）" : ""}</b> · ${esc(co.status)}</div>` +
        co.history.map(h => `<div>　· ${esc(h)}</div>`).join(""))
        .join("<div style='border-top:1px dashed var(--line);margin:4px 0;'></div>");
    $("#orderDetailDialog").showModal();
  }

  let reviewOrderId = null;
  function openReview(orderId) {
    const o = store.getOrder(orderId);
    if (o.status !== "待复核") return toast("只有待复核的令可以复核", true);
    reviewOrderId = orderId;
    fillSelects("#reviewDialog");
    $("#reviewIntro").innerHTML =
      `返工令 <b>${esc(o.id)}</b> · 操作者：<b>${esc(store.operatorName(o.operatorId))}</b>，请由另一人复核。<br>未复核通过，作品不能转入「待交付」。`;
    $("#reviewForm").reviewerId.value = "";
    $("#reviewForm").comment.value = "";
    $("#reviewDialog").showModal();
  }

  let reviseOrderId = null;
  function openRevise(orderId) {
    const o = store.getOrder(orderId);
    if (!o || o.archived) return toast("旧令已留档，不能再更正", true);
    reviseOrderId = orderId;
    fillSelects("#reviseDialog");
    const form = $("#reviseForm");
    form.responsibleProcess.value = o.responsibleProcess;
    form.operatorId.value = o.operatorId;
    form.promisedDate.value = o.promisedDate;
    $("#reviseMatRows").innerHTML = o.materials.map(m => matRowHtml(m.name, m.unit, m.need, m.ready)).join("");
    $("#reviseDialog").showModal();
  }

  // ============================================================
  // 事件绑定（事件委托）
  // ============================================================
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;

    const workActions = t.closest("[data-work]");
    if (workActions) {
      const workId = workActions.dataset.work;
      if (t.classList.contains("act-status")) {
        run(() => { store.setWorkStatus(workId, t.dataset.status); render(); toast(`作品状态已更新为「${t.dataset.status}」`); });
      } else if (t.classList.contains("act-defect")) {
        const text = prompt("输入断线/翘线位置");
        if (text) run(() => { store.recordDefect(workId, text); render(); toast("缺陷已记录"); });
      } else if (t.classList.contains("act-order")) {
        openCreateOrder(workId);
      } else if (t.classList.contains("act-detail")) {
        showWorkDetail(workId);
      }
      return;
    }

    // 详情对话框内的返工令跳转优先，避免被外层「作品 mini 卡片」点击抢先
    if (t.classList.contains("act-order-detail")) {
      $$("dialog").forEach(d => d.open && d.close());
      showOrderDetail(t.dataset.order);
      return;
    }

    const workMini = t.closest("[data-work-detail]");
    if (workMini) { showWorkDetail(workMini.dataset.workDetail); return; }
    if (t.classList.contains("act-start")) {
      run(() => { store.startOrder(t.dataset.order); render(); toast("已开工"); });
    } else if (t.classList.contains("act-complete")) {
      run(() => { store.completeOrder(t.dataset.order); render(); toast("已报完成，等待另一人复核"); });
    } else if (t.classList.contains("act-review")) {
      openReview(t.dataset.order);
    } else if (t.classList.contains("act-revise")) {
      openRevise(t.dataset.order);
    } else if (t.classList.contains("act-enqueue")) {
      const card = t.closest(".card, .process-block");
      const reasonEl = card ? card.querySelector(".in-reason") : null;
      run(() => {
        const res = S.enqueue(store, t.dataset.order, t.dataset.date, reasonEl ? reasonEl.value : "");
        render();
        if (res.bumpedOut.some(o => o.id === t.dataset.order)) toast("该令被挤下，原排期原因已保留", true);
        else if (res.bumpedOut.length) toast(`已排入；交付较晚的 ${res.bumpedOut.map(o => o.id).join("、")} 被挤下（原因保留）`);
        else toast("已排入补线工位");
      });
    }
  });

  // 备料数量即时更新
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("in-ready")) {
      run(() => { store.setMaterialReady(e.target.dataset.order, e.target.dataset.line, e.target.value); render(); });
    }
  });

  // 新增 / 删除材料行
  $("#addCreateMat").addEventListener("click", () => $("#createMatRows").insertAdjacentHTML("beforeend", matRowHtml("", "", "", 0)));
  $("#addReviseMat").addEventListener("click", () => $("#reviseMatRows").insertAdjacentHTML("beforeend", matRowHtml("", "", "", 0)));
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("mat-del")) e.target.closest(".mat-row").remove();
  });

  // 开具返工令提交
  $("#orderCreateForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    run(() => {
      store.createOrder({
        workId: createWorkId,
        responsibleProcess: f.responsibleProcess.value,
        operatorId: f.operatorId.value,
        promisedDate: f.promisedDate.value,
        materials: readMaterials($("#createMatRows"))
      });
      $("#orderCreateDialog").close();
      render();
      toast("返工令已开具");
    });
  });

  // 复核提交（通过 / 不通过两个按钮）
  $("#reviewForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    run(() => {
      const pass = store.reviewOrder(reviewOrderId, {
        reviewerId: f.reviewerId.value,
        comment: f.comment.value,
        pass: e.submitter.value === "1"
      });
      $("#reviewDialog").close();
      render();
      toast(pass ? "复核通过并放行，作品可转入待交付" : "复核不通过，退回返工中");
    });
  });

  // 更正派工提交
  $("#reviseForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    run(() => {
      const next = store.reviseOrder(reviseOrderId, {
        responsibleProcess: f.responsibleProcess.value,
        operatorId: f.operatorId.value,
        promisedDate: f.promisedDate.value,
        materials: readMaterials($("#reviseMatRows"))
      });
      $("#reviseDialog").close();
      render();
      toast(`旧令已留档，续次令 ${next.id} 重新备料排期`);
    });
  });

  // 作品表单
  const workForm = $("#workForm");
  workForm.addEventListener("submit", (e) => {
    e.preventDefault();
    run(() => {
      const data = Object.fromEntries(new FormData(workForm).entries());
      data.status = $("#workStatusSelect").value;
      store.addWork(data);
      workForm.reset();
      workForm.dryDate.value = todayStr();
      workForm.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      render();
      toast("作品已加入工坊");
    });
  });

  // 作品详情中的缺陷保存
  $("#saveDefect").addEventListener("click", () => {
    const v = $("#defectInput").value.trim();
    if (!v) return;
    run(() => {
      store.recordDefect(activeWorkId, v);
      $("#detailDialog").close();
      render();
      toast("缺陷已记录，可开具返工令");
    });
  });
  $("#closeDialog").addEventListener("click", () => $("#detailDialog").close());

  // 通用关闭按钮
  $$("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

  // 筛选与排序
  ["#statusFilter", "#themeFilter", "#sortMode"].forEach(sel =>
    $(sel).addEventListener("input", render));
  $("#clearFilters").addEventListener("click", () => {
    $("#themeFilter").value = "";
    $("#statusFilter").value = "";
    render();
  });

  // 判定日期与按日重算
  $("#planDate").addEventListener("change", render);
  $("#planDayBtn").addEventListener("click", () => run(() => {
    const date = $("#planDate").value;
    const report = S.planDay(store, date);
    render();
    const scheduled = report.rows.filter(r => r.result === "scheduled").length;
    const bumped = report.rows.length - scheduled;
    toast(`重算完成：排入 ${scheduled} 件${bumped ? `，挤下 ${bumped} 件（原因保留）` : ""}`);
  }));

  // 导出
  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-thread-workshop.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    $("#workStatusSelect").innerHTML = WORK_STATUSES.map(s => `<option>${s}</option>`).join("");
    $("#statusFilter").innerHTML = `<option value="">全部状态</option>` + WORK_STATUSES.map(s => `<option>${s}</option>`).join("");
    workForm.dryDate.value = todayStr();
    workForm.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    $("#planDate").value = todayStr();
    store.save();
    render();
  }

  init();
})(window);
