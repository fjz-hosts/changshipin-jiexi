/**
 * 音视频解析 - 使用助手 聊天核心逻辑
 * 本地问答引擎：基于关键词匹配 + 章节检索 + FAQ 匹配 + 快捷指南
 */

(function () {
  const K = window.KNOWLEDGE;

  // ===== DOM =====
  const $ = (sel) => document.querySelector(sel);
  const chatEl = $("#chat");
  const welcomeEl = $("#welcome");
  const inputEl = $("#input");
  const sendBtn = $("#send");
  const btnClear = $("#btn-clear");
  const btnTheme = $("#btn-theme");
  const quickGrid = $("#quick-grid");

  // ===== 会话历史（保存在 localStorage）=====
  const STORAGE_KEY = "changshipin-chat-history";
  const THEME_KEY = "changshipin-chat-theme";
  let history = [];

  // ===== 主题 =====
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.setAttribute("data-theme", "dark");
      btnTheme.textContent = "☀️";
    }
  }
  btnTheme.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    if (cur === "dark") {
      document.documentElement.removeAttribute("data-theme");
      btnTheme.textContent = "🌙";
      localStorage.setItem(THEME_KEY, "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
      btnTheme.textContent = "☀️";
      localStorage.setItem(THEME_KEY, "dark");
    }
  });

  // ===== 快速问题 =====
  const QUICK_QUESTIONS = [
    "怎么安装软件？Windows提示保护电脑怎么办？",
    "如何粘贴链接解析视频？",
    "解析失败一直转圈或黑屏怎么办？",
    "短视频怎么下载整个短剧全集？",
    "如何投屏到电视？",
    "音乐没有会员怎么下载？",
    "下载按钮是灰色的不能下载？",
    "有哪些快捷键？怎么全屏？",
    "夜间十点半后都解析失败？",
    "更新后设置和历史会丢吗？"
  ];

  function renderQuickQuestions() {
    QUICK_QUESTIONS.forEach((q, i) => {
      const div = document.createElement("div");
      div.className = "quick-item";
      div.textContent = q;
      div.addEventListener("click", () => sendMessage(q));
      quickGrid.appendChild(div);
    });
  }

  // ===== 会话恢复 =====
  function loadHistory() {
    try {
      history = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch { history = []; }

    if (history.length > 0) {
      welcomeEl.classList.add("hidden");
      chatEl.classList.remove("hidden");
      chatEl.innerHTML = "";
      history.forEach(({role, text}) => {
        appendMsg(role, text, false);
      });
      scrollToBottom();
    }
  }

  function saveHistory() {
    // 只保留最近 50 轮
    if (history.length > 50) {
      history = history.slice(-50);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }

  // ===== 渲染消息 =====
  function appendMsg(role, text, animate = true) {
    const div = document.createElement("div");
    div.className = "msg " + role + (animate ? "" : "");
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = role === "user" ? "👤" : "🎬";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = role === "assistant" ? renderMarkdown(text) : escapeHtml(text);
    div.appendChild(avatar);
    div.appendChild(bubble);
    chatEl.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // 简单 markdown 渲染
  function renderMarkdown(text) {
    let html = escapeHtml(text);
    // 章节引用
    html = html.replace(/「([^」]+)」/g, '<code>$1</code>');
    // 章节标记
    html = html.replace(/\(章节\s*[零一二三四五六七八九十\d]+\)/g, (m) => `<span class="section-ref">${m}</span>`);
    // 数字列表
    html = html.replace(/^(\d+)[.、]\s*(.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ol>${m}</ol>`);
    // 粗体
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 换行
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    return html;
  }

  // ===== 正在输入 =====
  function showTyping() {
    const div = document.createElement("div");
    div.className = "msg assistant typing";
    div.id = "typing-indicator";
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = "🎬";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    div.appendChild(avatar);
    div.appendChild(bubble);
    chatEl.appendChild(div);
    scrollToBottom();
  }

  function hideTyping() {
    const t = document.getElementById("typing-indicator");
    if (t) t.remove();
  }

  // ===== 发送消息 =====
  function sendMessage(text) {
    text = text.trim();
    if (!text) return;

    // 切换到对话视图
    welcomeEl.classList.add("hidden");
    chatEl.classList.remove("hidden");

    // 清空输入
    inputEl.value = "";
    autoResize();

    // 添加用户消息
    appendMsg("user", text);
    history.push({ role: "user", text });
    saveHistory();

    // 显示正在输入，然后回答
    showTyping();
    setTimeout(() => {
      hideTyping();
      const answer = generateAnswer(text);
      appendMsg("assistant", answer);
      history.push({ role: "assistant", text: answer });
      saveHistory();
    }, 400 + Math.random() * 500);
  }

  // ===== 问答引擎 =====

  // 计算查询与 FAQ 的匹配分数
  function calcFaqScore(query, faq) {
    const q = query.toLowerCase();
    let score = 0;
    const faqText = (faq.q + " " + (faq.keywords || []).join(" ")).toLowerCase();

    // 完全包含问题
    if (faqText.includes(q)) score += 10;

    // 关键词匹配
    const tokens = q.split(/[\s，。？！、,.!?]+/).filter(t => t.length >= 2);
    tokens.forEach(t => {
      if (faq.q.includes(t)) score += 5;
      if (faqText.includes(t)) score += 3;
      if (faq.a.toLowerCase().includes(t)) score += 1;
    });

    return score;
  }

  // 计算查询与章节的匹配分数
  function calcSectionScore(query, section) {
    const q = query.toLowerCase();
    let score = 0;
    const allText = (section.title + " " + section.summary + " " + (section.keywords || []).join(" ")).toLowerCase();

    // 标题直接包含
    if (section.title.includes(q)) score += 15;
    if (allText.includes(q)) score += 8;

    // 关键词命中
    const tokens = q.split(/[\s，。？！、,.!?]+/).filter(t => t.length >= 1);
    tokens.forEach(t => {
      if (t.length >= 2 && section.title.includes(t)) score += 6;
      if (t.length >= 2 && section.summary.includes(t)) score += 4;
      if (t.length >= 1 && (section.keywords || []).some(k => k.includes(t))) score += 5;
    });

    return score;
  }

  // 计算查询与快捷指南的匹配分数
  function calcGuideScore(query, guide) {
    const q = query.toLowerCase();
    let score = 0;
    if (guide.name.includes(q)) score += 12;
    const tokens = q.split(/[\s，。？！、,.!?]+/).filter(t => t.length >= 1);
    tokens.forEach(t => {
      if (t.length >= 2 && guide.name.includes(t)) score += 8;
      if (t.length >= 2 && guide.steps.some(s => s.includes(t))) score += 4;
    });
    return score;
  }

  // 主回答生成
  function generateAnswer(query) {
    const q = query.trim();

    // 1. 问候检测
    if (/^(你好|您好|hi|hello|在吗|在不在|嗨|哈喽)/i.test(q)) {
      return "你好！我是「音视频解析」的使用助手 🎬\n\n关于这个软件的任何问题都可以问我，比如：\n- 怎么安装？怎么下载？\n- 如何解析长视频/短视频/音乐？\n- 投屏、下载、快捷键怎么用？\n- 常见报错怎么解决？\n\n直接用自然语言问就可以，不用纠结关键词。";
    }

    // 2. 感谢语
    if (/^(谢谢|感谢|多谢|ok|好的|明白了|懂了|知道了)/i.test(q)) {
      return "不客气！如果还有其他问题随时问我 😊";
    }

    // 3. 先匹配 FAQ（最具体的问题优先）
    let bestFaq = null;
    let bestFaqScore = 0;
    K.faqs.forEach(faq => {
      const s = calcFaqScore(q, faq);
      if (s > bestFaqScore) {
        bestFaqScore = s;
        bestFaq = faq;
      }
    });

    // 4. 匹配章节（宽泛主题）
    let bestSection = null;
    let bestSectionScore = 0;
    K.sections.forEach(sec => {
      const s = calcSectionScore(q, sec);
      if (s > bestSectionScore) {
        bestSectionScore = s;
        bestSection = sec;
      }
    });

    // 5. 匹配快捷指南
    let bestGuide = null;
    let bestGuideScore = 0;
    K.quickGuide.forEach(g => {
      const s = calcGuideScore(q, g);
      if (s > bestGuideScore) {
        bestGuideScore = s;
        bestGuide = g;
      }
    });

    // 根据分数决定回答策略
    // FAQ 得分 >= 8 说明是具体问题
    // Section 得分 >= 10 说明是章节级问题
    // Guide 得分 >= 10 说明是操作步骤
    if (bestFaq && bestFaqScore >= 8) {
      return formatFaqAnswer(bestFaq, bestSection);
    }

    if (bestGuide && bestGuideScore >= 10) {
      return formatGuideAnswer(bestGuide, bestSection);
    }

    if (bestSection && bestSectionScore >= 8) {
      return formatSectionAnswer(bestSection, q);
    }

    // 没找到明确匹配，给出建议
    return formatFallback(q, bestFaq, bestSection, bestGuide);
  }

  function formatFaqAnswer(faq, section) {
    let ans = `**${faq.q}**\n\n${faq.a}`;
    if (section) {
      ans += `\n\n> 相关章节：${section.title}（可问我更多关于这个功能的细节）`;
    }
    return ans;
  }

  function formatGuideAnswer(guide, section) {
    let ans = `**${guide.name}**的操作步骤：\n\n`;
    guide.steps.forEach((step, i) => {
      ans += `${i + 1}. ${step}\n`;
    });
    ans += "\n还有不清楚的地方可以继续问我～";
    if (section) {
      ans += `（相关章节：${section.title}）`;
    }
    return ans;
  }

  function formatSectionAnswer(section, query) {
    let ans = `**${section.title}**\n\n${section.summary}`;

    // 如果用户问的是具体某个点，补充 FAQ
    const matchedFaqs = K.faqs
      .filter(f => calcFaqScore(query, f) >= 4)
      .slice(0, 2);
    if (matchedFaqs.length > 0) {
      ans += "\n\n**相关问题：**";
      matchedFaqs.forEach(f => {
        ans += `\n\n- **${f.q}**：${f.a}`;
      });
    }

    return ans;
  }

  function formatFallback(query, faq, section, guide) {
    let ans = `我没完全理解你的问题「${query}」，试试换个说法？\n\n`;
    ans += "你可以这样问我：\n";

    // 给出几个引导
    const suggestions = [
      "怎么安装软件？",
      "如何解析长视频？",
      "投屏怎么用？",
      "音乐下载不了怎么办？",
      "有哪些快捷键？"
    ];

    // 去掉和当前问题重复的
    const tokens = query.toLowerCase();
    const filtered = suggestions.filter(s => !tokens.includes(s.slice(0, 3)));
    ans += filtered.slice(0, 3).map(s => `- ${s}`).join("\n");

    // 如果有弱匹配，也提示一下
    if (section && section.score > 0) {
      ans += `\n\n你是不是想问关于「${section.title}」的问题？`;
    }
    if (faq) {
      ans += `\n\n类似问题：${faq.q} → ${faq.a}`;
    }

    return ans;
  }

  // ===== 输入框自动高度 =====
  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }

  inputEl.addEventListener("input", autoResize);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });
  sendBtn.addEventListener("click", () => sendMessage(inputEl.value));

  // ===== 清空 =====
  btnClear.addEventListener("click", () => {
    if (history.length === 0) return;
    if (!confirm("确定清空所有对话记录吗？")) return;
    history = [];
    localStorage.removeItem(STORAGE_KEY);
    chatEl.innerHTML = "";
    chatEl.classList.add("hidden");
    welcomeEl.classList.remove("hidden");
  });

  // ===== 初始化 =====
  initTheme();
  renderQuickQuestions();
  loadHistory();
  inputEl.focus();

})();
