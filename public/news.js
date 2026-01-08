// ====== タブ切り替え ======
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const tab = btn.dataset.tab;
    document.querySelectorAll(".tabPane").forEach(p => p.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");
  });
});

const elArticles = document.getElementById("articles");
const elTitle = document.getElementById("selectedTitle");
const elStatus = document.getElementById("status");
const elVocab = document.getElementById("vocabList");
const elParse = document.getElementById("parseBox");
const elQuiz = document.getElementById("quizBox");
const elQ = document.getElementById("q");

document.getElementById("reload").addEventListener("click", loadNews);
elQ.addEventListener("input", renderNews);

let news = [];
let selected = null;

// ====== まずはダミー ======
async function loadNews(){
  // 後で /api/news に差し替える
  news = [
    {
      id:"n1",
      title:"中国经济增长放缓的原因是什么？",
      snippet:"多项数据显示，消费与投资增长出现波动……",
      body:"多项数据显示，消费与投资增长出现波动。专家认为，房地产调整、外部需求变化等因素共同影响……"
    },
    {
      id:"n2",
      title:"人工智能在中国的发展现状",
      snippet:"多地出台支持政策，企业加速布局……",
      body:"多地出台支持政策，企业加速布局。与此同时，监管与伦理问题也受到关注……"
    }
  ];
  renderNews();
}
loadNews();

function renderNews(){
  const q = (elQ.value || "").trim();
  const list = q ? news.filter(a => (a.title + a.snippet).includes(q)) : news;

  elArticles.innerHTML = "";
  list.forEach(a => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="cardTitle">${escapeHtml(a.title)}</div>
      <div class="cardMeta">${escapeHtml(a.snippet)}</div>
    `;
    card.addEventListener("click", () => onSelect(a));
    elArticles.appendChild(card);
  });
}

async function onSelect(article){
  selected = article;
  elTitle.textContent = article.title;
  elStatus.textContent = "AI教材を生成中…（いまはダミー）";

  // 後で /api/analyze に差し替える
  const result = fakeAnalyze(article);

  renderVocab(result.vocab);
  renderParse(result.sentences);
  renderQuiz(result.quiz);

  elStatus.textContent = "生成完了";
}

function fakeAnalyze(article){
  return {
    vocab: [
      { zh:"放缓", pinyin:"fànghuǎn", pos:"动词", ja:"減速する", example:"经济增长放缓", note:"ニュース頻出。成長が遅くなる意味。" },
      { zh:"因素", pinyin:"yīnsù", pos:"名词", ja:"要因", example:"多种因素共同影响", note:"原因・要素のこと。" }
    ],
    sentences: [
      {
        zh:"多项数据显示，消费与投资增长出现波动。",
        ja_literal:"多くのデータは示す、消費と投資の成長が波動を現した。",
        ja_natural:"複数のデータによると、消費と投資の伸びに変動が出ている。",
        points:["“数据显示”＝データが示す","“出现”＝現れる/発生する（ニュース）"]
      }
    ],
    quiz: {
      tf: [
        { q:"この記事は『成長が加速している』と言っている。", a:false, why:"“放缓”は減速の意味。" }
      ],
      fill: [
        { q:"经济增长（　　）", answer:"放缓", why:"成長の減速を表す定番表現。" }
      ]
    }
  };
}

function renderVocab(vocab){
  if(!vocab?.length){
    elVocab.className = "vocabList empty";
    elVocab.textContent = "まだ単語がありません";
    return;
  }
  elVocab.className = "vocabList";
  elVocab.innerHTML = "";
  vocab.forEach(item => {
    const box = document.createElement("div");
    box.className = "vocabItem";
    box.innerHTML = `
      <div class="vocabTop">
        <div>
          <div class="zh">${escapeHtml(item.zh)}</div>
          <div class="py">${escapeHtml(item.pinyin)} ・ ${escapeHtml(item.ja)}</div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span class="badge">${escapeHtml(item.pos)}</span>
          <button class="smallBtn">⭐保存</button>
        </div>
      </div>
      <div class="example">${escapeHtml(item.example)}</div>
      <div class="note">${escapeHtml(item.note || "")}</div>
    `;
    // 保存は後で Socket.io or APIに繋ぐ
    box.querySelector("button").addEventListener("click", () => {
      alert(`保存（仮）：${item.zh}`);
    });
    elVocab.appendChild(box);
  });
}

function renderParse(sentences){
  if(!sentences?.length){
    elParse.className = "box empty";
    elParse.textContent = "まだ分解がありません";
    return;
  }
  elParse.className = "box";
  elParse.innerHTML = sentences.map(s => `
    <div class="vocabItem">
      <div class="cardTitle">${escapeHtml(s.zh)}</div>
      <div class="cardMeta">直訳：${escapeHtml(s.ja_literal)}</div>
      <div class="cardMeta">自然訳：${escapeHtml(s.ja_natural)}</div>
      <div class="note">ポイント：${(s.points||[]).map(escapeHtml).join(" / ")}</div>
    </div>
  `).join("");
}

function renderQuiz(quiz){
  const tf = (quiz?.tf || []).map((x,i)=>`
    <div class="vocabItem">
      <div class="cardTitle">〇×${i+1}. ${escapeHtml(x.q)}</div>
      <div class="note">答え：${x.a ? "〇" : "×"} ／ 解説：${escapeHtml(x.why)}</div>
    </div>
  `).join("");

  const fill = (quiz?.fill || []).map((x,i)=>`
    <div class="vocabItem">
      <div class="cardTitle">穴埋め${i+1}. ${escapeHtml(x.q)}</div>
      <div class="note">答え：${escapeHtml(x.answer)} ／ 解説：${escapeHtml(x.why)}</div>
    </div>
  `).join("");

  const html = (tf || fill) ? (tf + fill) : `<div class="empty">まだクイズがありません</div>`;
  elQuiz.className = "box";
  elQuiz.innerHTML = html;
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
