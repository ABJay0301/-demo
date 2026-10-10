/* =========================================================================
   课表提醒 · 主逻辑（纯前端，无任何依赖）
   -------------------------------------------------------------------------
   数据存放在浏览器 localStorage 中，不联网、不上传。
   模块顺序：常量 → 工具函数 → 存储 → 渲染 → 表单 → 通知调度 → 初始化
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     1. 常量与配置
     ======================================================================= */
  var K_COURSES = 'course-reminder:courses:v1';   // 课程数据
  var K_SETTINGS = 'course-reminder:settings:v1'; // 偏好设置
  var K_FIRED = 'course-reminder:fired:v1';       // 已提醒记录（防重复提醒）
  var K_VIEW = 'course-reminder:view:v1';         // 上次停留的标签页

  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var DAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

  // 柔和配色表：每节课挑一个，用于课表方块与列表
  var PALETTE = [
    { id: 'sky', bg: '#e3f0ff', bar: '#7fb3f5', text: '#2f5d94' },
    { id: 'mint', bg: '#e2f7ee', bar: '#6fd0a8', text: '#26765a' },
    { id: 'lilac', bg: '#ece8ff', bar: '#a894f7', text: '#54459b' },
    { id: 'peach', bg: '#ffece2', bar: '#f59b73', text: '#96502f' },
    { id: 'lemon', bg: '#fdf3d7', bar: '#e5c14b', text: '#8a7020' },
    { id: 'rose', bg: '#ffe6ef', bar: '#f287ab', text: '#9b3f63' },
    { id: 'aqua', bg: '#e0f5f8', bar: '#5fc3d1', text: '#256f7b' },
    { id: 'sand', bg: '#f0ece6', bar: '#b3a795', text: '#6a5d4a' }
  ];

  var REMIND_CHIPS = [0, 5, 10, 15, 30, 60]; // 常用提前提醒分钟数
  var SWEEP_MS = 15000;                      // 提醒巡检间隔

  // 上课周次：每周 / 单周 / 双周
  var WEEK_TYPES = [
    { id: 'all', label: '每周' },
    { id: 'odd', label: '单周' },
    { id: 'even', label: '双周' }
  ];

  var DEFAULT_SETTINGS = {
    defaultRemind: 15,
    vibrate: true,
    semesterStart: '', // 开学第一周周一的 'YYYY-MM-DD'；为空表示「以本周为第 1 周」
    totalWeeks: 20     // 学期总周数
  };

  /* =======================================================================
     2. 工具函数
     ======================================================================= */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'HH:MM' -> 从 0 点起的分钟数 */
  function toMin(hhmm) {
    var p = String(hhmm || '00:00').split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  /** 分钟数 -> 'HH:MM' */
  function toHHMM(min) {
    min = ((min % 1440) + 1440) % 1440;
    return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
  }
  /** HTML 转义，避免课程名里的特殊字符破坏结构 */
  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
  function weekTypeLabel(id) {
    for (var i = 0; i < WEEK_TYPES.length; i++) if (WEEK_TYPES[i].id === id) return WEEK_TYPES[i].label;
    return '每周';
  }
  function normalizeWeekType(v) {
    return (v === 'odd' || v === 'even') ? v : 'all';
  }

  /* --- 日期 --- */
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  /** 以周一为一周的第一天，返回 0~6 */
  function dowMon(d) { return (d.getDay() + 6) % 7; }
  /** 取某一天所在周的周一 */
  function mondayOfDate(d) { var t = startOfDay(d); return addDays(t, -dowMon(t)); }
  /** 取本周（或偏移 weekOffset 周）的周一 0 点 */
  function mondayOf(weekOffset) {
    return addDays(mondayOfDate(new Date()), (weekOffset || 0) * 7);
  }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function mdLabel(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
  /** 'YYYY-MM-DD' -> Date（本地时间 0 点），非法输入返回 Invalid Date */
  function parseYMD(s) {
    var p = String(s || '').split('-');
    if (p.length !== 3) return new Date(NaN);
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  /* --- 学期周次推算 --- */
  var WEEK_MS = 7 * 86400000;
  /** 开学第一周的周一 0 点 */
  function semesterMonday() {
    var d = parseYMD(settings.semesterStart);
    return isNaN(d.getTime()) ? mondayOfDate(new Date()) : mondayOfDate(d);
  }
  /** 某一天所属的学期周次（第 1 周 = 1，开学前为 0 或负数） */
  function weekIndexOf(date) {
    var diffDays = Math.round((mondayOfDate(date) - semesterMonday()) / WEEK_MS);
    return diffDays + 1;
  }
  /** 是否落在学期周次范围内 */
  function inSemester(idx) { return idx >= 1 && idx <= (settings.totalWeeks || 20); }
  /**
   * 这一周这门课到底上不上。
   * 学期外（开学前 / 假期）不做单双周过滤，方便查看整张课表。
   */
  function courseRunsInWeek(course, idx) {
    if (!course.weekType || course.weekType === 'all') return true;
    if (!inSemester(idx)) return true;
    return course.weekType === (idx % 2 === 1 ? 'odd' : 'even');
  }
  /** 周次长文案：第 8 周 · 双周 */
  function weekTitle(idx) {
    if (idx < 1) return '开学前';
    if (idx > (settings.totalWeeks || 20)) return '第 ' + idx + ' 周 · 假期';
    return '第 ' + idx + ' 周 · ' + (idx % 2 === 1 ? '单周' : '双周');
  }
  /** 周次短文案，给导航按钮用：第8周·双 */
  function weekShort(idx) {
    if (idx < 1) return '开学前';
    if (idx > (settings.totalWeeks || 20)) return '假期';
    return '第' + idx + '周·' + (idx % 2 === 1 ? '单' : '双');
  }

  /* --- UI 小件 --- */
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast is-show' + (type ? ' is-' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2400);
  }
  function paletteOf(id) {
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i].id === id) return PALETTE[i];
    return PALETTE[0];
  }

  /* =======================================================================
     3. 数据层（读写 localStorage）
     ======================================================================= */
  var courses = [];
  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var firedMap = {};    // { '课程id|时间戳|提前分钟': 触发时间 }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('[课表] 读取本地数据失败：', e);
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // 常见于 iOS 隐私模式或存储写满
      toast('本地保存失败，可能是隐私模式或空间不足', 'warn');
      console.warn('[课表] 写入本地数据失败：', e);
    }
  }
  /** 校验并从磁盘恢复课程，过滤掉损坏的条目 */
  function normalizeCourse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = String(raw.name || '').trim();
    if (!name) return null;
    var day = clamp(parseInt(raw.day, 10) || 0, 0, 6);
    var start = /^\d{1,2}:\d{2}$/.test(raw.start) ? raw.start : '08:00';
    var end = /^\d{1,2}:\d{2}$/.test(raw.end) ? raw.end : toHHMM(toMin(start) + 100);
    return {
      id: raw.id || uid(),
      name: name.slice(0, 20),
      day: day,
      start: start,
      end: end,
      room: String(raw.room || '').slice(0, 20),
      teacher: String(raw.teacher || '').slice(0, 15),
      note: String(raw.note || '').slice(0, 60),
      color: paletteOf(raw.color).id,
      remindBefore: clamp(parseInt(raw.remindBefore, 10) || 0, 0, 720),
      weekType: normalizeWeekType(raw.weekType)
    };
  }
  function loadData() {
    var rawCourses = readJSON(K_COURSES, []);
    courses = (Array.isArray(rawCourses) ? rawCourses : []).map(normalizeCourse).filter(Boolean);
    settings = Object.assign({}, DEFAULT_SETTINGS, readJSON(K_SETTINGS, {}) || {});
    firedMap = readJSON(K_FIRED, {}) || {};
    ensureSemesterStart();
    pruneFired();
  }
  /**
   * 学期起点兜底：设置里没有或非法时，默认「本周」为第 1 周并写入设置，
   * 这样周次与单双周在整个学期里都是稳定的。
   */
  function ensureSemesterStart() {
    var raw = settings.semesterStart;
    var valid = /^\d{4}-\d{2}-\d{2}$/.test(String(raw || '')) && !isNaN(parseYMD(raw).getTime());
    var monday = valid ? mondayOfDate(parseYMD(raw)) : mondayOf(0);
    settings.semesterStart = ymd(monday);
    var weeks = parseInt(settings.totalWeeks, 10);
    settings.totalWeeks = (isFinite(weeks) && weeks >= 1 && weeks <= 30) ? weeks : 20;
    if (!valid) saveSettings();
  }
  function saveCourses() { writeJSON(K_COURSES, courses); }
  function saveSettings() { writeJSON(K_SETTINGS, settings); }
  function saveFired() { writeJSON(K_FIRED, firedMap); }
  /** 清理 3 天前的已提醒记录，避免无限增长 */
  function pruneFired() {
    var limit = Date.now() - 3 * 86400000;
    var changed = false;
    Object.keys(firedMap).forEach(function (k) {
      if (firedMap[k] < limit) { delete firedMap[k]; changed = true; }
    });
    if (changed) saveFired();
  }
  /** 按 星期 → 开始时间 排序 */
  function sortedCourses() {
    return courses.slice().sort(function (a, b) {
      return a.day - b.day || toMin(a.start) - toMin(b.start) || a.name.localeCompare(b.name);
    });
  }

  /* =======================================================================
     4. 时间计算：某节课的下一次开课时间
     ======================================================================= */
  /** 某天（date）里这节课的开始时间；若该天不是这节课的星期则返回 null */
  function occurrenceOnDate(course, date) {
    if (dowMon(date) !== course.day) return null;
    var d = startOfDay(date);
    var m = toMin(course.start);
    d.setMinutes(m);
    return d;
  }
  /**
   * 从 from 时刻起，未来最近的一次开课时间。
   * 会跳过单双周不上课的周次，所以最多往后找 3 周。
   */
  function nextOccurrence(course, from) {
    var base = startOfDay(from);
    for (var i = 0; i <= 21; i++) {
      var day = addDays(base, i);
      var occ = occurrenceOnDate(course, day);
      if (!occ || occ.getTime() <= from.getTime()) continue;
      if (!courseRunsInWeek(course, weekIndexOf(day))) continue;
      return occ;
    }
    return null;
  }
  function durationMin(course) {
    var d = toMin(course.end) - toMin(course.start);
    return d > 0 ? d : 100; // 异常数据兜底
  }
  /** 把秒数格式化成倒计时文本 */
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d > 0) return d + ' 天 ' + pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
    return pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
  }

  /* =======================================================================
     5. 渲染：周课表
     ======================================================================= */
  var weekOffset = 0;       // 0 = 本周
  var gridStartMin = 7 * 60;  // 课表显示的时间范围（会根据课程自动扩展）
  var gridEndMin = 22 * 60;

  /** 读取 CSS 里的「每小时高度」，保证 JS 与样式只有一个数据源 */
  function hourHeight() {
    var v = getComputedStyle($('#weekTable')).getPropertyValue('--hour-h');
    var n = parseFloat(v);
    return isNaN(n) ? 76 : n;
  }

  /**
   * 计算课表要显示的时间范围：至少 07:00~22:00，有更早/更晚的课就自动扩展。
   * includeNow 为 true（正在看本周）时，额外保证「此刻」落在可视范围内，
   * 这样晚上 22 点以后也能看到当前时间红线。
   */
  function calcGridRange(includeNow) {
    var minM = 7 * 60, maxM = 22 * 60;
    courses.forEach(function (c) {
      minM = Math.min(minM, toMin(c.start));
      maxM = Math.max(maxM, toMin(c.end));
    });
    if (includeNow) {
      var now = new Date();
      var nowMin = now.getHours() * 60 + now.getMinutes();
      minM = Math.min(minM, Math.floor(nowMin / 60) * 60);
      maxM = Math.max(maxM, Math.min(24 * 60, Math.ceil((nowMin + 30) / 60) * 60));
    }
    gridStartMin = Math.floor(minM / 60) * 60;
    gridEndMin = Math.ceil(maxM / 60) * 60;
    if (gridEndMin - gridStartMin < 300) gridEndMin = gridStartMin + 300; // 至少 5 小时
  }

  function renderWeekHead(dates) {
    var todayKey = ymd(new Date());
    var html = '<div class="th-time">时间</div>';
    dates.forEach(function (d, i) {
      var isToday = ymd(d) === todayKey;
      var cls = 'th' + (isToday ? ' is-today' : '') + (i >= 5 ? ' is-weekend' : '');
      // 表头用 button，内部用 span（button 里放 div 属于非法嵌套）
      html += '<button type="button" class="' + cls + '" data-day="' + i + '" title="添加' + DAY_NAMES[i] + '的课程">' +
        '<span class="th__name">' + DAY_NAMES[i] + '</span>' +
        '<span class="th__date">' + mdLabel(d) + '</span>' +
        '</button>';
    });
    $('#tableHead').innerHTML = html;
  }

  function renderWeekBody(dates) {
    // weekOffset 为 0 表示正在看本周，此时把「现在」包进可视范围
    calcGridRange(weekOffset === 0);
    var hh = hourHeight();
    var totalMin = gridEndMin - gridStartMin;
    var bodyH = (totalMin / 60) * hh;
    var pxPerMin = hh / 60;
    var todayKey = ymd(new Date());
    var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    // 当前显示的这一周是学期第几周，据此过滤单双周课程
    var weekIdx = weekIndexOf(dates[0]);
    var weekCourses = courses.filter(function (c) { return courseRunsInWeek(c, weekIdx); });

    // 左侧时间轴
    var times = '';
    for (var m = gridStartMin; m < gridEndMin; m += 60) {
      times += '<div class="time-label">' + toHHMM(m) + '</div>';
    }

    var wrap = document.createElement('div');
    wrap.className = 'grid';
    wrap.innerHTML = '<div class="times" style="height:' + bodyH + 'px">' + times + '</div>';

    dates.forEach(function (d, dayIdx) {
      var col = document.createElement('div');
      col.className = 'daycol' + (ymd(d) === todayKey ? ' is-today' : '');
      col.style.height = bodyH + 'px';
      col.dataset.day = String(dayIdx);

      // 当前时间红线（只画在今天这一列）
      if (ymd(d) === todayKey && nowMin >= gridStartMin && nowMin <= gridEndMin) {
        var line = document.createElement('div');
        line.className = 'nowline';
        line.style.top = ((nowMin - gridStartMin) * pxPerMin) + 'px';
        col.appendChild(line);
      }

      // 这一天的课程
      weekCourses.filter(function (c) { return c.day === dayIdx; }).forEach(function (c) {
        var pal = paletteOf(c.color);
        var top = (toMin(c.start) - gridStartMin) * pxPerMin;
        var h = durationMin(c) * pxPerMin;
        // 超出显示范围时裁剪，但至少留一点高度便于点击
        var visibleTop = clamp(top, 0, bodyH - 20);
        var visibleH = clamp(h - (visibleTop - top), 20, bodyH - visibleTop);

        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'course' + (visibleH < 44 ? ' is-tiny' : '');
        el.style.top = visibleTop + 'px';
        el.style.height = visibleH + 'px';
        el.style.setProperty('--c-bg', pal.bg);
        el.style.setProperty('--c-bar', pal.bar);
        el.style.setProperty('--c-text', pal.text);
        el.dataset.id = c.id;
        el.innerHTML =
          (c.remindBefore ? '<span class="course__bell">🔔</span>' : '') +
          '<span class="course__name">' + esc(c.name) + '</span>' +
          '<span class="course__time">' + c.start + '-' + c.end + '</span>' +
          (c.room ? '<span class="course__room">' + esc(c.room) + '</span>' : '');
        col.appendChild(el);
      });

      wrap.appendChild(col);
    });

    // 重绘时保留原来的滚动位置，避免刷新后跳回顶部
    var box = $('#tableBody');
    var keepScroll = box.scrollTop;
    box.innerHTML = '';
    box.appendChild(wrap);
    box.scrollTop = keepScroll;

    // 这一周没课（或完全没课程）时，在表格上浮一层引导提示
    var table = $('#weekTable');
    var oldHint = table.querySelector('.grid-hint');
    if (oldHint) oldHint.parentNode.removeChild(oldHint);
    if (!weekCourses.length) {
      var hint = document.createElement('div');
      hint.className = 'grid-hint';
      hint.innerHTML = courses.length
        ? '<strong>这一周没有课</strong>课程被单双周过滤掉了<br>可以用上方箭头切到相邻周看看'
        : '<strong>这一周还是空的</strong>点右下角 “＋” 添加第一节课<br>也可以点上面的星期表头快速添加';
      table.appendChild(hint);
    }
  }

  /** 只移动「当前时间红线」，不重建整个课表（避免重绘动画和滚动跳动） */
  function updateNowLine() {
    var col = $('#tableBody .daycol.is-today');
    if (!col) return;
    var line = col.querySelector('.nowline');
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var inRange = nowMin >= gridStartMin && nowMin <= gridEndMin;
    if (!inRange) {
      if (line) line.remove();
      return;
    }
    if (!line) {
      line = document.createElement('div');
      line.className = 'nowline';
      col.appendChild(line);
    }
    line.style.top = ((nowMin - gridStartMin) * hourHeight() / 60) + 'px';
  }

  function renderWeekHeaderMeta() {
    var mon = mondayOf(weekOffset);
    var sun = addDays(mon, 6);
    var idx = weekIndexOf(mon);
    var label = $('#weekLabel');
    label.textContent = weekShort(idx);
    label.title = weekTitle(idx);
    $('#weekSub').textContent = mdLabel(mon) + '–' + mdLabel(sun) + (weekOffset === 0 ? ' · 本周' : '');
    // 已经在本周时不需要这个按钮
    $('#btnToday').hidden = weekOffset === 0;
  }

  var didAutoScroll = false;
  /** 首屏把滚动位置对准当前时间，省得手动往下翻 */
  function autoScrollGrid() {
    if (didAutoScroll) return;
    var box = $('#tableBody');
    if (!box) return;
    var hh = hourHeight();
    var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    var target = ((nowMin - gridStartMin) / 60) * hh - box.clientHeight * 0.32;
    box.scrollTop = clamp(target, 0, box.scrollHeight);
    didAutoScroll = true;
  }

  /* =======================================================================
     6. 渲染：下一节课 / 正在上课
     ======================================================================= */
  function findCurrentOrNext() {
    var now = new Date();
    var live = null, next = null;
    courses.forEach(function (c) {
      var occ = nextOccurrence(c, addDays(now, -1)); // 含今天已在进行的课
      if (!occ) return;
      var startMs = occ.getTime();
      var endMs = startMs + durationMin(c) * 60000;
      if (startMs <= now.getTime() && now.getTime() < endMs) {
        if (!live || startMs > live.startMs) live = { course: c, startMs: startMs, endMs: endMs };
      }
      if (startMs > now.getTime()) {
        if (!next || startMs < next.startMs) next = { course: c, startMs: startMs, endMs: endMs };
      }
    });
    return live || next;
  }

  function renderNextCard() {
    var card = $('#nextCard');
    var item = findCurrentOrNext();
    if (!item) {
      card.dataset.empty = 'true';
      card.classList.remove('is-live');
      $('#nextLabel').textContent = '下一节课';
      $('#nextName').textContent = courses.length ? '本周暂无安排' : '还没有课程';
      $('#nextMeta').textContent = courses.length ? '好好休息一下～' : '点右下角 “+” 添加你的第一节课';
      $('#nextTimer').hidden = true;
      return;
    }
    var c = item.course;
    var now = Date.now();
    var live = now >= item.startMs && now < item.endMs;
    var d = new Date(item.startMs);

    card.dataset.empty = 'false';
    card.classList.toggle('is-live', live);
    $('#nextLabel').textContent = live ? '正在上课' : '下一节课';
    $('#nextName').textContent = c.name;

    var bits = [DAY_NAMES[dowMon(d)] + ' ' + mdLabel(d), c.start + '-' + c.end];
    if (c.room) bits.push(c.room);
    if (c.teacher) bits.push(c.teacher);
    $('#nextMeta').textContent = bits.join(' · ');

    $('#nextTimer').hidden = false;
    if (live) {
      $('#nextNum').textContent = fmtCountdown(item.endMs - now);
      $('#nextUnit').textContent = '后下课';
    } else {
      $('#nextNum').textContent = fmtCountdown(item.startMs - now);
      var tip = c.remindBefore ? '后开始（会提前 ' + c.remindBefore + ' 分钟提醒）' : '后开始';
      $('#nextUnit').textContent = tip;
    }
  }

  /* =======================================================================
     7. 渲染：课程列表
     ======================================================================= */
  function renderList() {
    var box = $('#courseList');
    $('#courseCount').textContent = String(courses.length);
    if (!courses.length) {
      box.innerHTML = emptyState('还没有课程', '点右下角 “+” 添加你的第一节课');
      return;
    }
    var now = Date.now();
    var html = '';
    DAY_NAMES.forEach(function (dayName, dayIdx) {
      var list = courses.filter(function (c) { return c.day === dayIdx; })
        .sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
      if (!list.length) return;
      html += '<div class="daygroup"><div class="daygroup__title">' + dayName + ' · ' + list.length + ' 节</div>';
      list.forEach(function (c) {
        var pal = paletteOf(c.color);
        // 今天的状态标记：正在上课 / 已结束 / 本周不上 / 提醒方式
        var tag = c.remindBefore ? '提前 ' + c.remindBefore + ' 分钟提醒' : '不提醒';
        var tagCls = c.remindBefore ? '' : ' tag--off';
        var runsToday = courseRunsInWeek(c, weekIndexOf(new Date()));
        var occ = occurrenceOnDate(c, new Date());
        if (!runsToday) {
          tag = weekTypeLabel(c.weekType) + '课 · 本周不上';
          tagCls = ' tag--off';
        } else if (occ) {
          var s = occ.getTime(), e = s + durationMin(c) * 60000;
          if (now >= s && now < e) { tag = '正在上课'; tagCls = ' tag--live'; }
          else if (now >= e) { tag = '今天已结束'; tagCls = ' tag--off'; }
        }
        var sub = [c.start + '-' + c.end];
        if (c.room) sub.push(c.room);
        if (c.teacher) sub.push(c.teacher);
        if (c.note) sub.push(c.note);
        html +=
          '<button type="button" class="citem" data-id="' + c.id + '">' +
            '<span class="citem__bar" style="--c-bar:' + pal.bar + '"></span>' +
            '<span class="citem__main">' +
              '<span class="citem__name">' + esc(c.name) +
                (c.room ? '<span class="tag">' + esc(c.room) + '</span>' : '') +
                (c.weekType !== 'all' ? '<span class="tag tag--wk">' + weekTypeLabel(c.weekType) + '</span>' : '') +
              '</span>' +
              '<span class="citem__sub">' + esc(sub.join(' · ')) + '</span>' +
            '</span>' +
            '<span class="citem__right">' +
              '<span class="citem__time">' + c.start + '</span>' +
              '<span class="tag' + tagCls + '">' + esc(tag) + '</span>' +
            '</span>' +
          '</button>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }

  function emptyState(title, desc) {
    return '<div class="empty">' +
      '<div class="empty__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3.5v3M16 3.5v3M3.5 9.5h17M8.5 13.5h2M13.5 13.5h2M8.5 17h2M13.5 17h2"/></svg></div>' +
      '<div class="empty__title">' + esc(title) + '</div>' +
      '<div class="empty__desc">' + esc(desc) + '</div>' +
    '</div>';
  }

  /* =======================================================================
     8. 渲染：设置页与通知状态
     ======================================================================= */
  function notifySupported() { return typeof window.Notification !== 'undefined'; }
  // Service Worker 是否就绪：单文件版没有 sw.js，会退化成 false 并提示补文件
  var swReady = false;
  function permissionState() {
    if (!notifySupported()) return 'unsupported';
    return Notification.permission; // 'granted' | 'denied' | 'default'
  }
  function renderNotifyState() {
    var st = permissionState();
    var desc = $('#permDesc'), btn = $('#btnPerm'), dot = $('#bellDot');
    var needWarn = false;
    if (st === 'unsupported') {
      desc.textContent = '当前环境不支持通知，请把它添加到手机桌面后再打开';
      btn.textContent = '不可用';
      btn.disabled = true;
      needWarn = true;
    } else if (st === 'granted') {
      desc.textContent = '已开启，到点会弹出手机通知';
      btn.textContent = '已开启';
      btn.disabled = true;
    } else if (st === 'denied') {
      desc.textContent = '已被拒绝，请在浏览器/系统设置里手动允许通知';
      btn.textContent = '重新申请';
      needWarn = true;
    } else {
      desc.textContent = '未开启，开启后才能收到上课提醒';
      btn.textContent = '开启';
      needWarn = true;
    }
    // 顶栏小圆点：有待处理的提醒问题时显示
    dot.hidden = !(needWarn && courses.some(function (c) { return c.remindBefore > 0; }));
    // 没有 Service Worker 时，露出「下载 sw.js」那一行
    $('#rowSw').hidden = swReady;
  }
  function renderSettings() {
    $('#setDefaultRemind').value = String(settings.defaultRemind);
    $('#setVibrate').checked = !!settings.vibrate;
    $('#setSemesterStart').value = settings.semesterStart || '';
    $('#setTotalWeeks').value = String(settings.totalWeeks || 20);
    $('#semesterNoteWeeks').textContent = String(settings.totalWeeks || 20);
    var d = new Date();
    $('#todayWeekDesc').textContent = weekTitle(weekIndexOf(d)) +
      '（今天 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日）';
    renderNotifyState();
  }

  /* =======================================================================
     9. 统一渲染入口 + 视图切换
     ======================================================================= */
  function renderWeek() {
    var dates = [];
    var mon = mondayOf(weekOffset);
    for (var i = 0; i < 7; i++) dates.push(addDays(mon, i));
    renderWeekHeaderMeta();
    renderWeekHead(dates);
    renderWeekBody(dates);
    autoScrollGrid();
  }
  function renderAll() {
    renderWeek();
    renderNextCard();
    renderList();
    renderSettings();
  }

  var currentView = 'week';
  function switchView(view) {
    if (['week', 'list', 'settings'].indexOf(view) < 0) view = 'week';
    currentView = view;
    ['week', 'list', 'settings'].forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (el) el.hidden = v !== view;
    });
    $$('#tabbar .tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.view === view);
    });
    $('#viewTitle').textContent =
      view === 'week' ? '我的课表' : view === 'list' ? '课程管理' : '设置';
    // 设置页没有「添加课程」的场景，收起悬浮按钮避免挡住内容
    $('#fab').hidden = view === 'settings';
    writeJSON(K_VIEW, view);
  }

  /* =======================================================================
     10. 表单：添加 / 编辑课程
     ======================================================================= */
  var formState = { day: 0, color: 'sky', remind: 15, weekType: 'all' };
  var sheetOpen = false;

  function buildFormChips() {
    // 星期
    var dayHtml = '';
    for (var i = 0; i < 7; i++) {
      dayHtml += '<button type="button" class="chip" data-day="' + i + '">' + DAY_NAMES[i] + '</button>';
    }
    $('#fDayChips').innerHTML = dayHtml;

    // 提前提醒
    var rHtml = '';
    REMIND_CHIPS.forEach(function (m) {
      rHtml += '<button type="button" class="chip" data-remind="' + m + '">' +
        (m === 0 ? '不提醒' : '提前 ' + (m < 60 ? m + ' 分钟' : '1 小时')) + '</button>';
    });
    $('#fRemindChips').innerHTML = rHtml;

    // 上课周次：每周 / 单周 / 双周
    var wHtml = '';
    WEEK_TYPES.forEach(function (w) {
      wHtml += '<button type="button" class="chip" data-week="' + w.id + '">' + w.label + '</button>';
    });
    $('#fWeekChips').innerHTML = wHtml;

    // 颜色
    var cHtml = '';
    PALETTE.forEach(function (p) {
      cHtml += '<button type="button" class="swatch" data-color="' + p.id + '" aria-label="' + p.id +
        '" style="--c-bg:' + p.bg + ';--c-bar:' + p.bar + '"></button>';
    });
    $('#fColors').innerHTML = cHtml;
  }

  /**
   * 刷新表单里的选中态
   * @param {boolean} syncInput 是否把 formState.remind 写回分钟输入框
   *        （用户在输入框里打字时必须传 false，否则会覆盖他正在输入的内容）
   */
  function paintForm(syncInput) {
    $$('#fDayChips .chip').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.day) === formState.day);
    });
    $$('#fRemindChips .chip').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.remind) === formState.remind);
    });
    $$('#fColors .swatch').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.color === formState.color);
    });
    $$('#fWeekChips .chip').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.week === formState.weekType);
    });
    if (syncInput !== false) $('#fRemindCustom').value = String(formState.remind);
    paintRemindHint();
    paintWeekHint();
  }

  /** 上课周次下面的提示：现在第几周、这门课本周上不上 */
  function paintWeekHint() {
    var idx = weekIndexOf(new Date());
    var mine = formState.weekType === 'all' ? '每周都上' : ('只在' + weekTypeLabel(formState.weekType) + '上');
    var extra = '';
    if (formState.weekType !== 'all') {
      if (!inSemester(idx)) extra = '（学期外不过滤单双周）';
      else extra = courseRunsInWeek({ weekType: formState.weekType }, idx) ? '（本周会显示）' : '（本周不上）';
    }
    $('#weekHint').textContent = mine + ' · 现在是' + weekTitle(idx) + extra;
  }

  /** 输入框下方的即时提示：告诉用户当前填的值意味着什么 */
  function paintRemindHint() {
    var raw = $('#fRemindCustom').value;
    var hint = $('#remindHint');
    if (raw === '' || raw == null) { hint.textContent = '留空或填 0 表示这节课不提醒'; return; }
    var n = Number(raw);
    if (!isFinite(n)) { hint.textContent = '请输入数字'; return; }
    if (n < 0) { hint.textContent = '提醒时间不能为负数'; return; }
    if (n > 720) { hint.textContent = '最多提前 720 分钟（12 小时）'; return; }
    if (n === 0) { hint.textContent = '这节课不提醒'; return; }
    hint.textContent = '将在每节课开始前 ' + Math.round(n) + ' 分钟提醒你';
  }

  function clearErrors() {
    $$('.field__err').forEach(function (e) { e.textContent = ''; });
    $$('.input').forEach(function (i) { i.classList.remove('is-invalid'); });
    $$('.chips').forEach(function (c) { c.classList.remove('is-invalid'); });
  }

  /**
   * 打开课程表单
   * @param {object|null} course 传 null 表示新建
   * @param {object} prefill 新建时的预填值，如 { day: 2, start: '10:00' }
   */
  function openSheet(course, prefill) {
    clearErrors();
    var isEdit = !!course;
    $('#sheetTitle').textContent = isEdit ? '编辑课程' : '添加课程';
    $('#btnDeleteCourse').hidden = !isEdit;
    $('#fId').value = isEdit ? course.id : '';

    $('#fName').value = isEdit ? course.name : '';
    $('#fRoom').value = isEdit ? course.room : '';
    $('#fTeacher').value = isEdit ? course.teacher : '';
    $('#fNote').value = isEdit ? course.note : '';
    $('#fStart').value = isEdit ? course.start : (prefill && prefill.start) || '08:00';
    $('#fEnd').value = isEdit ? course.end : (prefill && prefill.end) || '09:40';

    formState.day = isEdit ? course.day : (prefill && typeof prefill.day === 'number' ? prefill.day : dowMon(new Date()));
    formState.color = isEdit ? course.color : PALETTE[Math.floor(Math.random() * PALETTE.length)].id;
    formState.remind = isEdit ? course.remindBefore : settings.defaultRemind;
    formState.weekType = isEdit ? (course.weekType || 'all') : 'all';
    paintForm();

    var backdrop = $('#backdrop'), sheet = $('#sheet');
    backdrop.hidden = false;
    sheet.hidden = false;
    // 强制一次重排，保证过渡动画生效
    void sheet.offsetHeight;
    backdrop.classList.add('is-open');
    sheet.classList.add('is-open');
    sheetOpen = true;
    document.body.style.overflow = 'hidden';
    $('#courseForm').scrollTop = 0;
    if (!isEdit) setTimeout(function () { $('#fName').focus(); }, 320);
  }

  function closeSheet() {
    var backdrop = $('#backdrop'), sheet = $('#sheet');
    backdrop.classList.remove('is-open');
    sheet.classList.remove('is-open');
    sheetOpen = false;
    document.body.style.overflow = '';
    setTimeout(function () {
      if (sheetOpen) return;
      backdrop.hidden = true;
      sheet.hidden = true;
    }, 350);
  }

  /** 表单校验，返回 { ok, data, firstBad } */
  function validateForm() {
    clearErrors();
    var errors = {};
    var name = $('#fName').value.trim();
    var start = $('#fStart').value;
    var end = $('#fEnd').value;
    var remindRaw = $('#fRemindCustom').value;
    var remind = formState.remind;

    if (!name) errors.name = '请填写课程名称';
    else if (name.length > 20) errors.name = '课程名称最多 20 个字';

    if (!start) errors.time = '请选择开始时间';
    if (!end) errors.time = '请选择结束时间';
    if (start && end && toMin(end) <= toMin(start)) {
      errors.time = '结束时间要晚于开始时间';
    } else if (start && end && toMin(end) - toMin(start) > 12 * 60) {
      errors.time = '单节课时长超过 12 小时，请检查时间';
    }

    if (remindRaw === '' || remindRaw == null) {
      remind = 0; // 输入框被清空 = 不提醒
    } else {
      var n = Number(remindRaw);
      if (!isFinite(n) || n < 0) errors.remind = '提醒时间不能为负数';
      else if (n > 720) errors.remind = '最多提前 720 分钟（12 小时）';
      else remind = Math.round(n);
    }
    if (isNaN(remind)) remind = 0;

    if (errors.name) { $('[data-err="name"]').textContent = errors.name; $('#fName').classList.add('is-invalid'); }
    if (errors.time) { $('[data-err="time"]').textContent = errors.time; }
    if (errors.remind) {
      $('[data-err="remind"]').textContent = errors.remind;
      $('#fRemindCustom').classList.add('is-invalid');
    }

    var firstBad = errors.name ? $('#fName') : (errors.time ? $('#fStart') : (errors.remind ? $('#fRemindCustom') : null));
    return {
      ok: !firstBad,
      firstBad: firstBad,
      data: {
        name: name,
        day: formState.day,
        start: start,
        end: end,
        room: $('#fRoom').value.trim(),
        teacher: $('#fTeacher').value.trim(),
        note: $('#fNote').value.trim(),
        color: formState.color,
        remindBefore: remind,
        weekType: formState.weekType
      }
    };
  }

  /** 检查与同一天其它课程是否时间重叠 */
  function findConflict(data, ignoreId) {
    var ns = toMin(data.start), ne = toMin(data.end);
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (c.id === ignoreId || c.day !== data.day) continue;
      var cs = toMin(c.start), ce = toMin(c.end);
      if (ns < ce && cs < ne) return c;
    }
    return null;
  }

  function submitForm(e) {
    e.preventDefault();
    var res = validateForm();
    if (!res.ok) {
      if (res.firstBad) {
        res.firstBad.classList.add('shake');
        setTimeout(function () { res.firstBad.classList.remove('shake'); }, 420);
        res.firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      toast('请检查标红的内容', 'warn');
      return;
    }
    var data = res.data;
    var id = $('#fId').value;
    var wasEdit = !!id;
    var conflict = findConflict(data, id);

    if (wasEdit) {
      var idx = courses.findIndex(function (c) { return c.id === id; });
      if (idx >= 0) courses[idx] = Object.assign({}, courses[idx], data);
    } else {
      data.id = uid();
      courses.push(data);
    }
    saveCourses();
    closeSheet();
    renderAll();

    if (conflict) {
      toast('已保存，但与「' + conflict.name + '」时间重叠', 'warn');
    } else {
      toast(wasEdit ? '已更新' : '已添加', 'ok');
    }
  }

  function deleteCourse(id) {
    var c = courses.find(function (x) { return x.id === id; });
    if (!c) return;
    if (!confirm('确定删除「' + c.name + '」这节课吗？')) return;
    courses = courses.filter(function (x) { return x.id !== id; });
    saveCourses();
    closeSheet();
    renderAll();
    toast('已删除', 'ok');
  }

  /* =======================================================================
     11. 通知与提醒调度
     ======================================================================= */
  /**
   * 发送通知：优先走 Service Worker（iOS 只支持这种方式，也只有它能在应用
   * 退到后台时显示通知），不支持时退回 new Notification。
   */
  function sendNotification(title, body, tag) {
    if (!notifySupported() || Notification.permission !== 'granted') return Promise.resolve(false);
    var options = {
      body: body,
      tag: tag,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      lang: 'zh-CN',
      data: { url: './index.html' }
    };
    if (settings.vibrate && navigator.vibrate) options.vibrate = [200, 80, 200];
    var reg = navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.ready : null;
    if (reg && reg.then) {
      return reg.then(function (r) {
        if (r && r.showNotification) return r.showNotification(title, options).then(function () { return true; });
        return fallbackNotify(title, options);
      }).catch(function () { return fallbackNotify(title, options); });
    }
    return Promise.resolve(fallbackNotify(title, options));
  }
  function fallbackNotify(title, options) {
    try { new Notification(title, options); return true; }
    catch (e) { console.warn('[课表] 通知发送失败：', e); return false; }
  }

  /**
   * 巡检所有课程，判断是否有该弹出的提醒。
   * 会同时检查「昨天/今天/明天」三次开课，兼容跨零点提醒。
   * 只有当前时间还没到上课时间才补发，避免上课上到一半才弹提醒。
   */
  function sweepReminders() {
    if (permissionState() !== 'granted') return;
    var now = Date.now();
    var base = new Date();
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (!c.remindBefore) continue;
      for (var off = -1; off <= 1; off++) {
        var occ = occurrenceOnDate(c, addDays(base, off));
        if (!occ) continue;
        // 单双周：这一周不上的话就不提醒
        if (!courseRunsInWeek(c, weekIndexOf(occ))) continue;
        var startMs = occ.getTime();
        var remindMs = startMs - c.remindBefore * 60000;
        if (now < remindMs || now >= startMs) continue;       // 未到点 / 已经开课
        var key = c.id + '|' + startMs + '|' + c.remindBefore;
        if (firedMap[key]) continue;                          // 已提醒过
        firedMap[key] = now;
        saveFired();

        var mins = Math.max(1, Math.round((startMs - now) / 60000));
        var detail = [c.start + '-' + c.end];
        if (c.room) detail.push(c.room);
        if (c.teacher) detail.push(c.teacher);
        if (c.note) detail.push(c.note);
        sendNotification(
          mins + ' 分钟后上课：' + c.name,
          detail.join(' · '),
          'course-' + c.id + '-' + startMs
        );
        if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 80, 200]);
        if (document.visibilityState === 'visible') toast(mins + ' 分钟后上课：' + c.name, 'warn');
        break; // 一节课同时只会命中一个开课时间
      }
    }
  }

  function requestPermission() {
    if (!notifySupported()) {
      toast('当前环境不支持通知，请先添加到手机桌面', 'warn');
      return;
    }
    Notification.requestPermission().then(function (p) {
      renderNotifyState();
      if (p === 'granted') {
        toast('通知已开启', 'ok');
        sendNotification('课表提醒已就绪', '到点会在这里提醒你上课 🎓', 'welcome');
        sweepReminders();
      } else if (p === 'denied') {
        toast('通知被拒绝，请在系统设置里允许', 'warn');
      } else {
        toast('还没有授予通知权限');
      }
    }).catch(function () { toast('无法申请通知权限', 'warn'); });
  }

  /* =======================================================================
     12. 数据导入 / 导出
     ======================================================================= */
  function exportData() {
    if (!courses.length) { toast('还没有课程可以导出', 'warn'); return; }
    var payload = {
      app: '课表提醒',
      version: 2,
      exportedAt: new Date().toISOString(),
      // 学期设置一起导出，换设备后单双周不会错位
      settings: {
        semesterStart: settings.semesterStart,
        totalWeeks: settings.totalWeeks,
        defaultRemind: settings.defaultRemind,
        vibrate: settings.vibrate
      },
      courses: courses
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '课表提醒-备份-' + ymd(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出备份文件', 'ok');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        var list = Array.isArray(parsed) ? parsed : parsed.courses;
        if (!Array.isArray(list)) throw new Error('格式不正确');
        var added = 0, updated = 0;
        list.forEach(function (raw) {
          var c = normalizeCourse(raw);
          if (!c) return;
          var idx = courses.findIndex(function (x) { return x.id === c.id; });
          if (idx >= 0) { courses[idx] = c; updated++; }
          else { courses.push(c); added++; }
        });
        // 备份里带了学期设置就一起恢复
        var withSettings = false;
        var s = parsed && parsed.settings;
        if (s && typeof s === 'object') {
          if (s.semesterStart) settings.semesterStart = s.semesterStart;
          if (s.totalWeeks) settings.totalWeeks = s.totalWeeks;
          if (s.defaultRemind != null) settings.defaultRemind = s.defaultRemind;
          if (typeof s.vibrate === 'boolean') settings.vibrate = s.vibrate;
          ensureSemesterStart();
          saveSettings();
          withSettings = true;
        }
        saveCourses();
        renderAll();
        toast('导入完成：新增 ' + added + ' 节，覆盖 ' + updated + ' 节' + (withSettings ? '，含学期设置' : ''), 'ok');
      } catch (err) {
        toast('导入失败：文件格式不正确', 'warn');
        console.warn('[课表] 导入失败：', err);
      }
    };
    reader.onerror = function () { toast('读取文件失败', 'warn'); };
    reader.readAsText(file);
  }

  /**
   * 下载 sw.js。
   * 单文件版里 Service Worker 源码被内联在 #swSource 中，直接取出下载；
   * 多文件版则回退到读取同目录的 sw.js。
   */
  function downloadSW() {
    var save = function (text) {
      var blob = new Blob([text], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sw.js';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已下载 sw.js，请放到与本页面同一个目录', 'ok');
    };
    var inline = document.getElementById('swSource');
    if (inline && inline.textContent.replace(/\s/g, '')) {
      save(inline.textContent);
      return;
    }
    fetch('./sw.js').then(function (r) { return r.text(); }).then(save)
      .catch(function () { toast('无法获取 sw.js，请与多文件版一起部署', 'warn'); });
  }

  /* =======================================================================
     13. 事件绑定
     ======================================================================= */
  function bindEvents() {
    /* --- 标签栏 --- */
    $('#tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (tab) switchView(tab.dataset.view);
    });

    /* --- 添加按钮 --- */
    $('#fab').addEventListener('click', function () { openSheet(null); });
    $('#btnAddFromList').addEventListener('click', function () { openSheet(null); });

    /* --- 周切换 --- */
    $('#btnPrevWeek').addEventListener('click', function () { weekOffset--; didAutoScroll = false; renderWeek(); });
    $('#btnNextWeek').addEventListener('click', function () { weekOffset++; didAutoScroll = false; renderWeek(); });
    $('#btnToday').addEventListener('click', function () {
      weekOffset = 0; didAutoScroll = false; renderWeek(); toast('已回到本周');
    });

    /* --- 课表交互：点表头快速加课、点课程块编辑 --- */
    $('#tableHead').addEventListener('click', function (e) {
      var th = e.target.closest('.th');
      if (!th) return;
      openSheet(null, { day: Number(th.dataset.day) });
    });
    $('#tableBody').addEventListener('click', function (e) {
      var block = e.target.closest('.course');
      if (!block) return;
      var c = courses.find(function (x) { return x.id === block.dataset.id; });
      if (c) openSheet(c);
    });
    // 双击课表空白处 = 快捷添加
    $('#tableBody').addEventListener('dblclick', function (e) {
      if (e.target.closest('.course')) return;
      var col = e.target.closest('.daycol');
      openSheet(null, col ? { day: Number(col.dataset.day) } : undefined);
    });

    /* --- 列表点击编辑 --- */
    $('#courseList').addEventListener('click', function (e) {
      var item = e.target.closest('.citem');
      if (!item) return;
      var c = courses.find(function (x) { return x.id === item.dataset.id; });
      if (c) openSheet(c);
    });

    /* --- 弹层关闭 --- */
    $('#backdrop').addEventListener('click', closeSheet);
    $('#btnCloseSheet').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheetOpen) closeSheet();
    });

    /* --- 表单内的选择项 --- */
    $('#fDayChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      formState.day = Number(chip.dataset.day);
      $('[data-err="day"]').textContent = '';
      paintForm(false); // 只换高亮，不动用户输入
    });
    $('#fRemindChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      formState.remind = Number(chip.dataset.remind);
      $('#fRemindCustom').classList.remove('is-invalid');
      $('[data-err="remind"]').textContent = '';
      paintForm(); // 选了快捷项，同步写回输入框
    });
    // 打字过程中只更新高亮与提示文案，绝不改写用户正在输入的内容
    $('#fRemindCustom').addEventListener('input', function () {
      var raw = this.value;
      if (raw === '') {
        formState.remind = 0;
      } else {
        var n = Number(raw);
        formState.remind = (isFinite(n) && n >= 0 && n <= 720) ? Math.round(n) : NaN;
      }
      this.classList.remove('is-invalid');
      $('[data-err="remind"]').textContent = '';
      paintForm(false);
    });
    $('#fColors').addEventListener('click', function (e) {
      var sw = e.target.closest('.swatch');
      if (!sw) return;
      formState.color = sw.dataset.color;
      paintForm(false);
    });
    $('#fWeekChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      formState.weekType = normalizeWeekType(chip.dataset.week);
      paintForm(false);
    });
    // 快捷课时：一键填好开始/结束时间
    $('#quickTime').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var parts = chip.dataset.range.split('|');
      $('#fStart').value = parts[0];
      $('#fEnd').value = parts[1];
      $('[data-err="time"]').textContent = '';
      $$('#quickTime .chip').forEach(function (b) { b.classList.toggle('is-active', b === chip); });
    });
    // 输入时清掉对应错误提示
    $('#fName').addEventListener('input', function () {
      this.classList.remove('is-invalid');
      $('[data-err="name"]').textContent = '';
    });
    $('#fStart').addEventListener('input', function () {
      $('[data-err="time"]').textContent = '';
      $$('#quickTime .chip').forEach(function (b) { b.classList.remove('is-active'); });
    });
    $('#fEnd').addEventListener('input', function () {
      $('[data-err="time"]').textContent = '';
      $$('#quickTime .chip').forEach(function (b) { b.classList.remove('is-active'); });
    });

    /* --- 表单提交 / 删除 --- */
    $('#courseForm').addEventListener('submit', submitForm);
    $('#btnDeleteCourse').addEventListener('click', function () {
      var id = $('#fId').value;
      if (id) deleteCourse(id);
    });

    /* --- 设置项 --- */
    $('#btnPerm').addEventListener('click', requestPermission);
    $('#btnBell').addEventListener('click', function () {
      switchView('settings');
      if (permissionState() !== 'granted') requestPermission();
    });
    $('#btnTestNotify').addEventListener('click', function () {
      if (permissionState() !== 'granted') { toast('请先开启通知权限', 'warn'); return; }
      sendNotification('测试通知 · 课表提醒', '看到这条说明手机能正常收到提醒 ✅', 'test-' + Date.now())
        .then(function (ok) { toast(ok ? '已发送测试通知' : '通知发送失败', ok ? 'ok' : 'warn'); });
    });
    $('#setDefaultRemind').addEventListener('change', function () {
      settings.defaultRemind = Number(this.value);
      saveSettings();
      toast('默认提醒已更新', 'ok');
    });
    $('#setVibrate').addEventListener('change', function () {
      settings.vibrate = this.checked;
      saveSettings();
    });
    $('#btnDownloadSw').addEventListener('click', downloadSW);

    /* --- 学期与周次 --- */
    $('#setSemesterStart').addEventListener('change', function () {
      var v = this.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(parseYMD(v).getTime())) {
        toast('日期格式不正确', 'warn');
        renderSettings();
        return;
      }
      // 统一对齐到那一周的周一，保证第几周 / 单双周的口径一致
      settings.semesterStart = ymd(mondayOfDate(parseYMD(v)));
      saveSettings();
      renderAll();
      toast('开学第一周设为 ' + settings.semesterStart, 'ok');
    });
    $('#setTotalWeeks').addEventListener('change', function () {
      var n = clamp(parseInt(this.value, 10) || 20, 1, 30);
      settings.totalWeeks = n;
      saveSettings();
      renderAll();
      toast('学期共 ' + n + ' 周', 'ok');
    });
    $('#btnResetSemester').addEventListener('click', function () {
      settings.semesterStart = ymd(mondayOf(0));
      saveSettings();
      renderAll();
      toast('已把本周设为第 1 周', 'ok');
    });

    /* --- 数据管理 --- */
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
    $('#fileImport').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) importData(f);
      this.value = ''; // 允许重复选择同一个文件
    });
    $('#btnClear').addEventListener('click', function () {
      if (!courses.length) { toast('当前没有课程'); return; }
      if (!confirm('确定清空全部 ' + courses.length + ' 节课程吗？此操作不可恢复。')) return;
      courses = [];
      saveCourses();
      renderAll();
      toast('已清空全部课程', 'ok');
    });

    /* --- 回到前台 / 切换桌面时补检提醒 --- */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        sweepReminders();
        checkDayRollover();
        renderNextCard();
      }
    });

    /* --- 注册 Service Worker（PWA 离线 + 通知支持） --- */
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').then(function () {
          // 等 SW 就绪后再巡检一次，确保能走 showNotification
          return navigator.serviceWorker.ready;
        }).then(function () {
          swReady = true;
          renderNotifyState();
          sweepReminders();
        }).catch(function (err) {
          // 单文件版通常在这里失败：通知以外的功能都照常可用
          swReady = false;
          renderNotifyState();
          console.warn('[课表] Service Worker 注册失败（单文件版可下载 sw.js 修复）：', err);
        });
      });
    }
  }

  /* =======================================================================
     14. 定时器：秒级刷新倒计时、分钟级刷新课表红线
     ======================================================================= */
  var lastDayKey = ymd(new Date());
  function checkDayRollover() {
    var key = ymd(new Date());
    if (key !== lastDayKey) {
      lastDayKey = key;
      didAutoScroll = false;
      renderAll();
    }
  }
  /** 顶部日期文案：10月10日 周五 */
  function renderTodayLabel() {
    var d = new Date();
    $('#todayLabel').textContent =
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DAY_NAMES[dowMon(d)];
  }
  function startTimers() {
    renderTodayLabel();
    // 每秒刷新倒计时
    setInterval(renderNextCard, 1000);
    // 每 15 秒巡检提醒
    setInterval(function () { sweepReminders(); checkDayRollover(); }, SWEEP_MS);
    // 每 30 秒只挪一下红线 + 刷新日期文案，不重建课表
    setInterval(function () {
      updateNowLine();
      renderTodayLabel();
    }, 30000);
  }

  /* =======================================================================
     15. 启动
     ======================================================================= */
  function init() {
    injectManifest(); // 单文件版：运行时注入 manifest
    loadData();
    buildFormChips();
    bindEvents();
    renderAll();
    switchView(readJSON(K_VIEW, 'week'));
    startTimers();
    sweepReminders(); // 打开应用时补发一次

    // 支持桌面图标长按菜单里的快捷方式：?action=add / ?view=list|settings
    var query = location.search || '';
    var viewMatch = /[?&]view=(week|list|settings)/.exec(query);
    if (viewMatch) switchView(viewMatch[1]);
    if (/[?&]action=add/.test(query)) setTimeout(function () { openSheet(null); }, 360);
  }

  /**
   * 单文件版专用：manifest 内联在 <script id="manifestTemplate"> 里，
   * 运行时生成 blob 清单再注入 <link rel="manifest">（多文件版没有这段，直接跳过）。
   */
  function injectManifest() {
    var tpl = document.getElementById('manifestTemplate');
    if (!tpl) return;
    if (document.querySelector('link[rel="manifest"]')) return;
    try {
      var m = JSON.parse(tpl.textContent);
      var base = (location.origin && location.origin !== 'null') ? location.origin : '';
      m.start_url = base + location.pathname;
      m.scope = base + location.pathname.replace(/[^/]*$/, '');
      if (!m.id) m.id = m.scope;
      var blob = new Blob([JSON.stringify(m)], { type: 'application/manifest+json' });
      var link = document.createElement('link');
      link.rel = 'manifest';
      link.href = URL.createObjectURL(blob);
      document.head.appendChild(link);
    } catch (e) {
      console.warn('[课表] 注入 manifest 失败：', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
