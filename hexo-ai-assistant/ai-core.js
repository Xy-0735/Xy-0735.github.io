(function () {
  'use strict';

  var CONFIG = window.AI_ASSISTANT_CONFIG || {};

  // ========== Knowledge Base ==========
  var knowledgeBase = [];
  var kbLoaded = false;

  async function loadKnowledgeBase() {
    if (kbLoaded) return;
    try {
      var resp = await fetch(CONFIG.kbUrl || '/hexo-ai-assistant/blog-knowledge-base.json');
      if (!resp.ok) throw new Error('Failed to load knowledge base');
      knowledgeBase = await resp.json();
      kbLoaded = true;
    } catch (e) {
      console.warn('[AI Assistant] Knowledge base load failed:', e.message);
    }
  }

  // ========== Search Engine ==========

  function tokenize(text) {
    var cleaned = (text || '').toLowerCase()
      .replace(/[^\w一-鿿]/g, ' ')
      .replace(/([一-鿿])/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.split(' ').filter(function (w) { return w.length > 0; });
  }

  function scoreArticle(query, article) {
    var queryTokens = tokenize(query);
    if (queryTokens.length === 0) return 0;

    var titleTokens = tokenize(article.title);
    var contentTokens = tokenize((article.excerpt || '') + ' ' + (article.content || '').slice(0, 1000));

    var score = 0;
    for (var i = 0; i < queryTokens.length; i++) {
      var qt = queryTokens[i];
      // Title matches weighted 5x
      for (var j = 0; j < titleTokens.length; j++) {
        if (titleTokens[j] === qt || (qt.length > 1 && titleTokens[j].indexOf(qt) !== -1)) {
          score += 5;
        }
      }
      // Content matches weighted 1x
      for (var k = 0; k < contentTokens.length; k++) {
        if (contentTokens[k] === qt || (qt.length > 1 && contentTokens[k].indexOf(qt) !== -1)) {
          score += 1;
        }
      }
    }
    // Tag match bonus
    if (article.tags && article.tags.length) {
      for (var m = 0; m < queryTokens.length; m++) {
        var qtm = queryTokens[m];
        for (var n = 0; n < article.tags.length; n++) {
          var tag = article.tags[n].toLowerCase();
          if (tag === qtm || tag.indexOf(qtm) !== -1 || qtm.indexOf(tag) !== -1) {
            score += 3;
          }
        }
      }
    }
    return score;
  }

  function search(query, topK) {
    topK = topK || 3;
    if (knowledgeBase.length === 0) return [];
    var scored = knowledgeBase.map(function (article) {
      return { article: article, score: scoreArticle(query, article) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, topK).filter(function (s) { return s.score > 0; }).map(function (s) { return s.article; });
  }

  // ========== Chat Client ==========

  function buildContext(results) {
    var ctx = '以下是与用户问题相关的博客文章内容：\n\n';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      ctx += '【文章' + (i + 1) + '】标题：' + r.title + '\n';
      ctx += '链接：' + r.permalink + '\n';
      ctx += '内容摘要：' + (r.excerpt || '') + '\n';
      ctx += '正文片段：' + (r.content || '').slice(0, 2000) + '\n\n';
    }

    ctx += '以下是所有博客文章的标题索引：\n';
    for (var j = 0; j < knowledgeBase.length; j++) {
      var item = knowledgeBase[j];
      ctx += '- ' + item.title + ' (' + item.permalink + ')\n';
    }
    return ctx;
  }

  function buildSystemPrompt() {
    return '你是博客「' + (CONFIG.blogName || '') + '」的 AI 智能助手。'
      + '你的任务是基于提供的博客文章内容来回答用户的问题。\n\n'
      + '规则：\n'
      + '1. 优先使用提供的文章内容回答问题\n'
      + '2. 引用文章时，使用 Markdown 链接格式标注出处，如 [文章标题](链接)\n'
      + '3. 如果提供的文章内容不足以回答，可以结合你的知识补充，但要说明哪些信息来自博客\n'
      + '4. 回答简洁清晰，避免冗长\n'
      + '5. 使用中文回答';
  }

  async function chat(query, conversationHistory, onChunk) {
    await loadKnowledgeBase();

    if (knowledgeBase.length === 0) {
      onChunk('知识库未加载，请刷新页面后重试。');
      return;
    }

    var results = search(query, 3);
    var context = buildContext(results);

    var messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: context }
    ];

    if (conversationHistory && conversationHistory.length > 0) {
      var recent = conversationHistory.slice(-10);
      messages.push.apply(messages, recent);
    }

    messages.push({ role: 'user', content: query });

    // Use proxy if configured (API key stays server-side)
    var useProxy = !!(CONFIG.proxyUrl);
    var apiUrl = useProxy
      ? CONFIG.proxyUrl
      : (CONFIG.chatApiUrl || 'https://api.deepseek.com/v1/chat/completions');

    var headers = { 'Content-Type': 'application/json' };
    if (!useProxy) {
      headers['Authorization'] = 'Bearer ' + (CONFIG.chatApiKey || '');
    }

    try {
      var response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: CONFIG.chatModel || 'deepseek-chat',
          messages: messages,
          stream: true
        })
      });

      if (!response.ok) {
        var errText = await response.text();
        onChunk('API 请求失败：' + response.status + ' ' + errText.slice(0, 200));
        return;
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var trimmed = lines[i].trim();
          if (!trimmed || trimmed.indexOf('data: ') !== 0) continue;
          var data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            var parsed = JSON.parse(data);
            var content = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (content) onChunk(content);
          } catch (e) {
            // Skip malformed JSON chunks
          }
        }
      }
    } catch (e) {
      onChunk('网络请求失败：' + e.message);
    }
  }

  // ========== Conversation Manager ==========

  var STORAGE_KEY = 'ai_assistant_history';
  var MAX_HISTORY = 20;

  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
    } catch (e) {
      // sessionStorage might be full or unavailable
    }
  }

  function clearHistory() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  // ========== Public API ==========
  window.AIAssistant = {
    loadKnowledgeBase: loadKnowledgeBase,
    search: search,
    chat: chat,
    loadHistory: loadHistory,
    saveHistory: saveHistory,
    clearHistory: clearHistory,
    getKnowledgeBase: function () { return knowledgeBase; },
    isLoaded: function () { return kbLoaded; }
  };
})();
