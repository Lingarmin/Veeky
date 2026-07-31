(function runDemo() {
  const {
    advanceAnalysis,
    createDemoState,
    filterTranscript,
    formatTime,
    seekTo,
    selectSection,
    switchTab,
  } = window.DemoState;

  const chapters = [
    {
      time: 0,
      title: "从一个手写数字开始",
      summary: "作者用识别手写数字的任务说明神经网络需要解决什么问题。",
      variant: 0,
    },
    {
      time: 198,
      title: "神经元保存的其实是数值",
      summary: "一张图片被拆成 784 个像素值，每个值对应输入层中的一个神经元。",
      variant: 1,
    },
    {
      time: 456,
      title: "权重和偏置决定连接",
      summary: "网络通过权重组合上一层数值，再用偏置调整神经元被激活的难易程度。",
      variant: 2,
    },
    {
      time: 762,
      title: "训练就是不断修正参数",
      summary: "反向传播根据预测误差调整权重，让网络在更多样本上逐步提高准确率。",
      variant: 3,
    },
  ];

  const transcript = [
    { time: 0, original: "This is a 3, sloppily written and rendered at an extremely low resolution.", translated: "这是一个写得有些潦草、分辨率又很低的数字 3。" },
    { time: 26, original: "The task is to take this grid of pixels and recognize which digit it represents.", translated: "任务是读取这组像素，并判断它代表哪个数字。" },
    { time: 82, original: "A neural network is simply a function, one that learns from examples.", translated: "神经网络可以看作一个从样本中学习的函数。" },
    { time: 198, original: "Each neuron holds a number between zero and one.", translated: "每个神经元保存一个 0 到 1 之间的数值。" },
    { time: 286, original: "The middle layers are where we hope the network learns useful patterns.", translated: "我们希望网络能在中间层学会有用的模式。" },
    { time: 456, original: "Each connection has a weight, and each neuron has a bias.", translated: "每条连接都有权重，每个神经元还有一个偏置。" },
    { time: 642, original: "The activation function compresses the result into a useful range.", translated: "激活函数会把计算结果压缩到便于处理的范围内。" },
    { time: 762, original: "Training means finding weights and biases that make the network perform well.", translated: "训练就是寻找一组能让网络表现良好的权重和偏置。" },
    { time: 986, original: "The important part is how these parameters change when the answer is wrong.", translated: "真正需要理解的是，答案出错时这些参数如何变化。" },
  ];

  let state = createDemoState();
  let analysisTimer = null;
  let toastTimer = null;

  const viewport = document.querySelector(".browser-viewport");
  const panel = document.getElementById("sidePanel");
  const panelBody = document.getElementById("panelBody");
  const youtubePage = document.getElementById("youtubePage");
  const articlePage = document.getElementById("articlePage");
  const addressText = document.getElementById("addressText");
  const progress = document.getElementById("playerProgress");
  const currentTime = document.getElementById("currentTime");
  const toast = document.getElementById("toast");

  function render() {
    document.querySelectorAll("[data-browser-tab]").forEach((button) => {
      const active = button.dataset.browserTab === state.activeTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });

    const onYoutube = state.activeTab === "youtube";
    youtubePage.hidden = !onYoutube;
    articlePage.hidden = onYoutube;
    panel.hidden = !state.panelVisible;
    viewport.classList.toggle("panel-hidden", !state.panelVisible);
    addressText.textContent = onYoutube
      ? "youtube.com/watch?v=aircAruvnKk"
      : "notes.local/projects/video-preview/week-31";

    document.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === state.section;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });

    currentTime.textContent = formatTime(state.currentTime);
    progress.style.width = `${(state.currentTime / state.duration) * 100}%`;

    if (state.analysisStatus !== "complete") {
      renderProcessing();
    } else if (state.section === "transcript") {
      renderTranscript("");
    } else {
      renderOverview();
    }
  }

  function renderOverview() {
    panelBody.innerHTML = `
      <section class="overview">
        <p class="eyebrow">19 分钟读懂</p>
        <h2>神经网络如何识别手写数字</h2>
        <p class="summary-lead">视频从像素和神经元讲起，逐步解释层、权重与偏置，最后说明训练过程如何根据错误修正参数。</p>

        <div class="summary-facts" aria-label="视频摘要数据">
          <div><strong>4</strong><span>内容章节</span></div>
          <div><strong>9</strong><span>重点片段</span></div>
          <div><strong>6 分钟</strong><span>预计阅读</span></div>
        </div>

        <ul class="takeaways">
          <li>输入层把 28 × 28 的图片转换成 784 个像素数值。</li>
          <li>隐藏层尝试组合边缘、笔画等局部模式，而不是直接记住图片。</li>
          <li>训练通过误差调整权重和偏置，让正确数字获得更高激活值。</li>
        </ul>

        <div class="section-heading"><h3>章节与重点</h3><span>点击跳转视频</span></div>
        <div class="chapter-list">
          ${chapters.map((chapter, index) => `
            <article class="chapter" tabindex="0" role="button" data-seek="${chapter.time}" aria-label="跳转到 ${formatTime(chapter.time)} ${chapter.title}">
              <canvas width="182" height="110" data-thumb="${chapter.variant}" aria-hidden="true"></canvas>
              <div class="chapter-copy">
                <span class="chapter-time">${formatTime(chapter.time)}</span>
                <h4>${chapter.title}</h4>
                <p>${chapter.summary}</p>
              </div>
            </article>
          `).join("")}
        </div>
      </section>
    `;

    panelBody.querySelectorAll("[data-seek]").forEach((item) => {
      item.addEventListener("click", () => handleSeek(Number(item.dataset.seek)));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSeek(Number(item.dataset.seek));
        }
      });
    });
    drawThumbnails();
  }

  function renderTranscript(query) {
    const matches = filterTranscript(transcript, query);
    panelBody.innerHTML = `
      <section class="transcript-view">
        <div class="search-wrap">
          <input id="transcriptSearch" type="search" value="${escapeHtml(query)}" placeholder="搜索原文或译文" aria-label="搜索逐字稿" />
        </div>
        <div id="transcriptResults">
          ${matches.length ? matches.map((segment) => `
            <article class="transcript-segment">
              <button class="transcript-time" type="button" data-seek="${segment.time}">${formatTime(segment.time)}</button>
              <div class="transcript-copy">
                <p>${segment.translated}</p>
                <p class="original" lang="en">${segment.original}</p>
              </div>
            </article>
          `).join("") : '<p class="empty-search">没有找到匹配的字幕</p>'}
        </div>
      </section>
    `;

    const search = document.getElementById("transcriptSearch");
    search.addEventListener("input", (event) => {
      const value = event.target.value;
      renderTranscript(value);
      const next = document.getElementById("transcriptSearch");
      next.focus();
      next.setSelectionRange(value.length, value.length);
    });
    panelBody.querySelectorAll("[data-seek]").forEach((button) => {
      button.addEventListener("click", () => handleSeek(Number(button.dataset.seek)));
    });
  }

  function renderProcessing() {
    const stages = [
      ["checking", "检查公开字幕"],
      ["translating", "翻译为简体中文"],
      ["summarizing", "整理章节与重点"],
    ];
    const activeIndex = stages.findIndex(([id]) => id === state.analysisStatus);
    panelBody.innerHTML = `
      <section class="processing">
        <div class="processing-visual" aria-hidden="true">
          <div class="processing-lines">
            <i class="processing-node"></i><i class="processing-node"></i><i class="processing-node"></i>
          </div>
        </div>
        <h2>正在读这条视频</h2>
        <p>分析在后台继续。切换网页不会中断，回到这个标签页后仍能看到结果。</p>
        <div>
          ${stages.map(([id, label], index) => {
            const statusClass = index < activeIndex ? "is-done" : index === activeIndex ? "is-active" : "";
            const statusText = index < activeIndex ? "完成" : index === activeIndex ? "进行中" : "等待";
            return `<div class="processing-step ${statusClass}"><i>${index < activeIndex ? "✓" : "·"}</i><strong>${label}</strong><span>${statusText}</span></div>`;
          }).join("")}
        </div>
      </section>
    `;
  }

  function handleSeek(seconds) {
    state = seekTo(state, seconds);
    currentTime.textContent = formatTime(state.currentTime);
    progress.style.width = `${(state.currentTime / state.duration) * 100}%`;
    showToast(`视频已定位到 ${formatTime(seconds)}`);
  }

  function restartAnalysis() {
    if (analysisTimer) window.clearInterval(analysisTimer);
    state = { ...state, analysisStatus: "checking", section: "overview" };
    render();
    analysisTimer = window.setInterval(() => {
      state = advanceAnalysis(state);
      render();
      if (state.analysisStatus === "complete") {
        window.clearInterval(analysisTimer);
        analysisTimer = null;
        showToast("分析完成");
      }
    }, 1050);
  }

  function showToast(message) {
    if (toastTimer) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
  }

  function drawNetwork(canvas, variant) {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const width = rect.width;
    const height = rect.height;
    ctx.fillStyle = variant === 3 ? "#171717" : "#080808";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255,255,255,.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

    if (variant === 0) {
      ctx.strokeStyle = "#f2f2f2";
      ctx.lineWidth = Math.max(4, width / 85);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(width * .19, height * .27);
      ctx.bezierCurveTo(width * .29, height * .11, width * .47, height * .16, width * .43, height * .38);
      ctx.bezierCurveTo(width * .38, height * .50, width * .29, height * .48, width * .28, height * .50);
      ctx.bezierCurveTo(width * .49, height * .45, width * .52, height * .79, width * .29, height * .83);
      ctx.bezierCurveTo(width * .19, height * .85, width * .13, height * .78, width * .12, height * .72);
      ctx.stroke();
      drawNetworkColumns(ctx, width * .61, width * .91, height, 3);
    } else {
      drawNetworkColumns(ctx, width * .12, width * .88, height, variant);
    }
  }

  function drawNetworkColumns(ctx, startX, endX, height, variant) {
    const columns = variant === 2 ? [5, 7, 4] : [6, 5, 6];
    const points = [];
    columns.forEach((count, column) => {
      const x = startX + ((endX - startX) * column) / (columns.length - 1);
      points[column] = [];
      for (let index = 0; index < count; index += 1) {
        const y = height * .16 + ((height * .68) * index) / Math.max(1, count - 1);
        points[column].push({ x, y });
      }
    });
    ctx.lineWidth = 1;
    for (let column = 0; column < points.length - 1; column += 1) {
      points[column].forEach((from, fromIndex) => {
        points[column + 1].forEach((to, toIndex) => {
          ctx.strokeStyle = (fromIndex + toIndex + variant) % 4 === 0 ? "rgba(233,47,35,.7)" : "rgba(255,255,255,.14)";
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        });
      });
    }
    points.flat().forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, index % 5 === 0 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = index % 5 === 0 ? "#e92f23" : "#dadada";
      ctx.fill();
    });
  }

  function drawThumbnails() {
    panelBody.querySelectorAll("canvas[data-thumb]").forEach((canvas) => drawNetwork(canvas, Number(canvas.dataset.thumb)));
  }

  function escapeHtml(value) {
    return value.replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

  document.querySelectorAll("[data-browser-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state = switchTab(state, button.dataset.browserTab);
      render();
    });
  });

  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      state = selectSection(state, button.dataset.section);
      render();
    });
  });

  document.getElementById("rerunButton").addEventListener("click", restartAnalysis);
  document.getElementById("playButton").addEventListener("click", () => showToast("演示播放器已暂停"));
  window.addEventListener("resize", () => drawNetwork(document.getElementById("videoCanvas"), 0));

  render();
  drawNetwork(document.getElementById("videoCanvas"), 0);
})();
