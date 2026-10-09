import { DAILY_LEARNING_SOURCES, normalizeDailyLearningPreferences, parseDailyVocabularyResponse, parseGeneratedSentenceResponse, selectedLearningRows, validateGeneratedSentence } from './daily-learning.js?v=V1_5_6';
import { normalizeJapaneseAnswer } from './japanese-learning.js?v=V1_5_6';
export function createGeminiClient(DB) {
return {
  _modelCatalog: null,
  _modelCatalogPromise: null,
  _catalogKey: '',
  _catalogError: null,
  lastUsedModel: '',
  invalidateCatalog() {
    this._modelCatalog = null;
    this._catalogKey = '';
    this._modelCatalogPromise = null;
    this._catalogError = null;
  },
  async ensureModelCatalog() {
    try { return await this.discoverModels(); }
    catch (error) {
      this._catalogError = error;
      // List metadata can be unavailable even when generateContent is permitted.
      // Still test the explicitly selected endpoint, but never hide key/permission failures.
      if ([401, 403].includes(Number(error?.status)) || error?.message === 'API_KEY_CHANGED') throw error;
      return this.AVAILABLE_MODELS;
    }
  },
  // All selectable models (display name -> API id)
  AVAILABLE_MODELS: [
    { label: 'Gemini 3.8 Flash',      id: 'gemini-3.8-flash',      tag: '推薦・最新穩定', tier: 'stable' },
    { label: 'Gemini 3.7 Flash',      id: 'gemini-3.7-flash',      tag: '穩定', tier: 'stable' },
    { label: 'Gemini 3.6 Flash',      id: 'gemini-3.6-flash',      tag: '穩定', tier: 'stable' },
    { label: 'Gemini 3.5 Flash',      id: 'gemini-3.5-flash',      tag: '穩定', tier: 'stable' },
    { label: 'Gemini 3.5 Flash-Lite', id: 'gemini-3.5-flash-lite', tag: '快速・穩定', tier: 'stable' },
    { label: 'Gemini 3.1 Flash-Lite', id: 'gemini-3.1-flash-lite', tag: '快速・穩定', tier: 'stable' },
    { label: 'Gemini 2.5 Flash',      id: 'gemini-2.5-flash',      tag: '相容備援', tier: 'stable' },
    { label: 'Gemini 2.5 Flash-Lite', id: 'gemini-2.5-flash-lite', tag: '省配額・相容備援', tier: 'stable' },
    { label: 'Gemini 2.5 Pro',        id: 'gemini-2.5-pro',        tag: '高階・相容備援', tier: 'stable' },
    { label: 'Gemini 3.1 Pro Preview', id: 'gemini-3.1-pro-preview', tag: '預覽', tier: 'preview' },
    { label: 'Gemini 3 Flash Preview', id: 'gemini-3-flash-preview', tag: '預覽', tier: 'preview' },
  ],

  async discoverModels() {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    // Keep only a one-way fingerprint and public model metadata in the cache.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (this._modelCatalog?.fingerprint === fingerprint && Date.now() < this._modelCatalog.expiresAt) {
      return this._modelCatalog.models;
    }
    if (this._modelCatalogPromise?.fingerprint === fingerprint) return this._modelCatalogPromise.promise;
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const models = [];
        let pageToken = '';
        for (let page = 0; page < 5; page++) {
          const params = new URLSearchParams({ pageSize: '1000' });
          if (pageToken) params.set('pageToken', pageToken);
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params}`, {
            headers: { 'x-goog-api-key': apiKey }, signal: controller.signal, cache: 'no-store'
          });
          if (!response.ok) {
            const error = this._tagError(new Error('MODEL_LIST_FAILED'), { status: response.status });
            throw error;
          }
          const data = await response.json();
          for (const model of data.models || []) {
            if (!model.supportedGenerationMethods?.includes('generateContent')) continue;
            const id = String(model.name || '').replace(/^models\//, '');
            if (!/^gemini-[a-z0-9.-]+$/i.test(id)) continue;
            // generateContent also serves image/audio endpoints. Only offer text-learning models.
            if (/image|tts|audio|live|transcribe|translate|omni|robot|embedding/i.test(id)) continue;
            models.push({ id, label: model.displayName || id, tier: /preview|experimental|exp(?:-|$)/i.test(id) ? 'preview' : 'stable' });
          }
          pageToken = String(data.nextPageToken || '');
          if (!pageToken) break;
          if (page === 4) throw new Error('MODEL_LIST_INCOMPLETE');
        }
        if (!models.length) throw new Error('NO_GENERATION_MODELS');
        if (DB.getApiKey() !== apiKey) throw new Error('API_KEY_CHANGED');
        const preferred = new Map(this.AVAILABLE_MODELS.map((model, index) => [model.id, index]));
        models.sort((a, b) => (preferred.get(a.id) ?? 100) - (preferred.get(b.id) ?? 100) || a.id.localeCompare(b.id));
        this._catalogKey = apiKey; // memory-only; excluded from model metadata and all backups
        this._catalogError = null;
        this._modelCatalog = { fingerprint, expiresAt: Date.now() + 6 * 60 * 60 * 1000, models };
        return models;
      } finally { clearTimeout(timer); }
    })();
    this._modelCatalogPromise = { fingerprint, promise };
    try { return await promise; }
    finally { if (this._modelCatalogPromise?.promise === promise) this._modelCatalogPromise = null; }
  },

  // Production fallback stays on stable endpoints. Preview models are tried only when explicitly selected.
  _getModelList() {
    const selected = DB.getModel();
    const currentCatalog = this._modelCatalog && this._catalogKey === DB.getApiKey() && Date.now() < this._modelCatalog.expiresAt;
    const catalog = currentCatalog ? this._modelCatalog.models : this.AVAILABLE_MODELS;
    const selectedMeta = catalog.find(m => m.id === selected);
    const stableIds = catalog.filter(m => m.tier === 'stable').map(m => m.id);
    const previewIds = selectedMeta?.tier === 'preview'
      ? catalog.filter(m => m.tier === 'preview').map(m => m.id)
      : [];
    return [...new Set([selectedMeta || !currentCatalog ? selected : '', ...stableIds, ...previewIds])].filter(Boolean);
  },

  _shortTaskModels() {
    const list = this._getModelList();
    const compatible = list.find(id => /^gemini-2\.5-flash$/.test(id));
    return [...new Set([list[0], list.find(id => id !== list[0] && id !== compatible), compatible])].filter(Boolean);
  },

  _shortTaskBudget() { return { deadline: Date.now() + 60000, requests: 0, maxRequests: 3 }; },

  // Read final visible output only. Thought parts are never a substitute for a
  // missing final answer because they may contain fragments, labels or drafts.
  _extractResponse(data) {
    const candidate = data?.candidates?.[0] || null;
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter(part => !part?.thought && typeof part?.text === 'string')
      .map(part => part.text)
      .join('')
      .trim();
    return {
      text,
      finishReason: String(candidate?.finishReason || ''),
      finishMessage: String(candidate?.finishMessage || ''),
      tokenCount: Number(candidate?.tokenCount || data?.usageMetadata?.candidatesTokenCount || 0),
      modelVersion: String(data?.modelVersion || '')
    };
  },

  _extractText(data) { return this._extractResponse(data).text; },

  _tagError(error, details = {}) {
    const tagged = error instanceof Error ? error : new Error(String(error || 'API_ERROR'));
    Object.assign(tagged, details);
    return tagged;
  },

  _isSchemaCompatibilityError(error) {
    return Number(error?.status) === 400 && /responseSchema|response_schema|responseMimeType|response_mime_type|schema is not supported|unknown name ["']?(?:responseSchema|responseMimeType)/i.test(error?.message || '');
  },

  _canTryAnotherModel(error) {
    if (!error) return false;
    if (error.fallback) return true;
    return /MODEL_|EMPTY_FINAL_RESPONSE|AI_OUTPUT_INVALID|PARSE_ERROR|SENTENCE_VALIDATION_FAILED|API_RESPONSE_INVALID|API_TIMEOUT/i.test(error.message || '');
  },

  describeError(error, task = 'Gemini') {
    const status = Number(error?.status || 0);
    const model = error?.model ? `（${error.model}）` : '';
    const message = String(error?.message || 'API_ERROR');
    if (message === 'NO_API_KEY') return '尚未設定 Gemini API Key。';
    if (message === 'API_KEY_CHANGED') return '生成期間 API Key 已變更，請使用目前設定重新生成。';
    if (/MODEL_LIST|NO_GENERATION_MODELS/.test(message)) return '暫時無法取得可用的文字模型，請稍後重新查詢。';
    if (message === 'NETWORK_ERROR') return '瀏覽器無法連上 Gemini API；這不代表裝置斷網，可能是瀏覽器連線、內容阻擋或暫時性服務問題。';
    if (message === 'API_TIMEOUT') return `Gemini 回應逾時${model}，系統已停止等待，請稍後重試。`;
    if (status === 401 || status === 403 || /API_KEY_INVALID|permission denied|api key/i.test(message)) {
      return `Gemini API Key 無效、受限制或沒有模型權限${model}。`;
    }
    if (status === 404 || /not found|not supported|deprecated/i.test(message)) {
      return `所選 Gemini 模型目前不可用${model}，請重新查詢模型列表並執行連線測試。`;
    }
    if (status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit/i.test(message)) {
      return `Gemini 配額或速率限制已達上限${model}，請稍後再試。`;
    }
    if (status >= 500 || /unavailable|overloaded/i.test(message)) {
      return `Gemini 服務暫時無法完成請求${model}。`;
    }
    if (/AI_OUTPUT_INVALID|PARSE_ERROR|EMPTY_FINAL_RESPONSE|MODEL_MAX_TOKENS|SENTENCE_VALIDATION_FAILED/i.test(message)) {
      return `${task}收到的 AI 內容不完整或格式不符${model}，系統已攔截，請重試。`;
    }
    if (status === 400) return `Gemini 拒絕此請求${model}（HTTP 400），請執行設定頁的連線測試。`;
    return `${task}暫時無法完成${model}；請到設定頁執行 Gemini 連線測試查看原因。`;
  },

  _plainJsonBody(prompt, maxOutputTokens) {
    return JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens }
    });
  },

  async _callStructured(model, { prompt, responseSchema, maxOutputTokens }, apiKey, retryTransient = true, budget = null) {
    const structuredBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema
      }
    });
    try {
      return await this._callModelDetailed(model, structuredBody, apiKey, 0, retryTransient, budget);
    } catch (error) {
      // Some older or restricted endpoints reject responseSchema even though
      // they can still return valid JSON. Retry once without the schema.
      if (!this._isSchemaCompatibilityError(error)) throw error;
      return this._callModelDetailed(
        model,
        this._plainJsonBody(prompt, maxOutputTokens),
        apiKey,
        0,
        retryTransient,
        budget
      );
    }
  },

  async _callModelDetailed(model, body, apiKey, attempt = 0, retryTransient = true, budget = null) {
    if (DB.getApiKey() !== apiKey) throw new Error('API_KEY_CHANGED');
    this.lastUsedModel = model;
    if (budget && (budget.requests >= budget.maxRequests || Date.now() >= budget.deadline)) {
      throw this._tagError(new Error('API_TIMEOUT'), { model, fallback: false });
    }
    if (budget) budget.requests += 1;
    const controller = new AbortController();
    const requestTimeout = budget ? Math.min(30000, Math.max(1, budget.deadline - Date.now())) : 45000;
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body, signal: controller.signal }
      );
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        let apiStatus = '';
        try {
          const d = await res.json();
          errMsg = d.error?.message || errMsg;
          apiStatus = d.error?.status || '';
        } catch {}
        const lower = String(errMsg).toLowerCase();
        const err = this._tagError(new Error(errMsg), { status: res.status, apiStatus, model });
        const apiKeyProblem = lower.includes('api key') || lower.includes('apikey') || lower.includes('permission denied') || lower.includes('authentication');
        const modelProblem = lower.includes('model') || lower.includes('not found') || lower.includes('not supported') || lower.includes('deprecated') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('unavailable') || this._isSchemaCompatibilityError(err);
        if (retryTransient && !apiKeyProblem && attempt < 2 && [408, 429, 500, 502, 503, 504].includes(res.status)) {
          const delay = Math.min(700 * (2 ** attempt) + Math.floor(Math.random() * 250), 2500);
          if (budget && (budget.requests >= budget.maxRequests || Date.now() + delay >= budget.deadline)) throw err;
          await new Promise(resolve => setTimeout(resolve, delay));
          return this._callModelDetailed(model, body, apiKey, attempt + 1, retryTransient, budget);
        }
        err.fallback = !apiKeyProblem && (
          [404, 408, 429, 500, 502, 503, 504].includes(res.status) ||
          (res.status === 400 && modelProblem && this._isSchemaCompatibilityError(err))
        );
        throw err;
      }
      const data = await res.json();
      if (DB.getApiKey() !== apiKey) throw new Error('API_KEY_CHANGED');
      return { ...this._extractResponse(data), model };
    } catch (error) {
      if (error?.name === 'AbortError') throw this._tagError(new Error('API_TIMEOUT'), { model, fallback: true });
      if (error instanceof SyntaxError) throw this._tagError(new Error('API_RESPONSE_INVALID'), { model, fallback: true });
      if (error?.fallback !== undefined || /^HTTP\s\d+/i.test(error?.message || '') || /quota|permission|api key|model|schema/i.test(error?.message || '')) throw error;
      if (error?.name === 'TypeError') throw this._tagError(new Error('NETWORK_ERROR'), { model });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  async _callModel(model, body, apiKey, attempt = 0) {
    return (await this._callModelDetailed(model, body, apiKey, attempt, true)).text;
  },

  async reviewEssay(essay, words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const wordList = words.map(w => `"${w.english}" (${w.partOfSpeech}: ${w.chinese})`).join(', ');
    const prompt = `You are a Japanese writing teacher for a Traditional Chinese learner. Review the Japanese composition below.

Required vocabulary words: ${wordList}

Student Japanese composition:
${essay}

Respond ONLY with a single valid JSON object. No markdown fences, no explanation, no text before or after the JSON.
Required format:
{"wordCheck":[{"word":"string","used":true,"correct":true,"note":"string"}],"grammar":[{"exact":"string","corrected":"string","explanation":"string"}],"suggestions":["string"],"score":7,"comment":"string"}

Rules:
- wordCheck: one entry per required vocabulary word (used=false if not found in essay)
- grammar: list up to 5 errors in particles, conjugation, kanji/kana spelling, word choice, or naturalness (empty array [] if none).
  CRITICAL CONSTRAINT: Keep each required Japanese vocabulary item unchanged in "corrected". Fix only the surrounding grammar and expression.
  "exact" must be the EXACT substring copied verbatim from the student essay so it can be found by string search. "corrected" is the fixed replacement. "explanation" is in Traditional Chinese (繁體中文).
- suggestions: 2-3 tips to improve the essay in Traditional Chinese (繁體中文). Do NOT suggest replacing the required vocabulary words.
- comment: one sentence overall evaluation in Traditional Chinese (繁體中文)
- score: integer 1-10`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2500 }
    });

    // Helper: extract first valid JSON object from raw text
    const extractJSON = (raw) => {
      // Remove thinking tags (Gemini 2.5 Flash thinking model)
      let text = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
      // Remove markdown fences (```json ... ``` or ``` ... ```)
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      // Find the first { ... } block (handles leading/trailing whitespace or text)
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error(`PARSE_ERROR: no JSON found in response`); continue; }
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.score !== 'undefined') return parsed;
        lastErr = new Error('PARSE_ERROR: missing score field');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error(`PARSE_ERROR: ${err.message}`); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },
  // Review essay with a free topic (no required vocabulary words)
  async reviewEssayFree(essay, topic) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const prompt = `You are a Japanese writing teacher for a Traditional Chinese learner. The student was given this topic/prompt: "${topic}"

Student essay:
${essay}

Respond ONLY with a single valid JSON object. No markdown fences, no explanation.
Required format:
{"grammar":[{"exact":"string","corrected":"string","explanation":"string"}],"suggestions":["string"],"score":7,"comment":"string"}

Rules:
- grammar: up to 5 errors in particles, conjugation, kanji/kana spelling, word choice, or naturalness. "exact" must be verbatim from the composition. "explanation" in 繁體中文.
- suggestions: 2-3 tips in 繁體中文.
- comment: one sentence evaluation in 繁體中文.
- score: integer 1-10`;

    const body = JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.2,maxOutputTokens:2500} });

    const extractJSON = (raw) => {
      let text = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi,'').trim()
        .replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`\s*$/,'').trim();
      const start = text.indexOf('{'); const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error('PARSE_ERROR: no JSON'); continue; }
        const parsed = JSON.parse(jsonStr);
        // Normalize: add empty wordCheck for compatibility
        if (parsed && typeof parsed.score !== 'undefined') {
          parsed.wordCheck = parsed.wordCheck || [];
          return parsed;
        }
        lastErr = new Error('PARSE_ERROR: missing score');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error('PARSE_ERROR: ' + err.message); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },

  async generateSentence(word) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const target = {
      word: String(word.english || '').trim(),
      reading: String(word.reading || word.phonetic || '').trim(),
      romaji: String(word.romaji || '').trim(),
      partOfSpeech: String(word.partOfSpeech || '語彙').trim(),
      meaning: String(word.chinese || '').trim(),
      level: String(word.level || DB.getJlptLevel?.() || 'N5').toUpperCase()
    };
    if (!target.word) throw new Error('INVALID_TARGET_WORD');

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        ja: { type: 'STRING', description: 'Natural Japanese example sentence using the required target word.' },
        kana: { type: 'STRING', description: 'Full reading of the entire Japanese sentence using kana only.' },
        zh: { type: 'STRING', description: 'Accurate Traditional Chinese translation.' }
      },
      required: ['ja', 'kana', 'zh'],
      propertyOrdering: ['ja', 'kana', 'zh']
    };
    let lastErr = null;
    const models = this._shortTaskModels();
    const budget = this._shortTaskBudget();
    for (let attempt = 0; attempt < models.length; attempt++) {
      const model = models[attempt];
      const correction = lastErr?.validationReason
        ? `\nThe previous output was rejected (${lastErr.validationReason}). Correct that defect in this response.`
        : '';
      const prompt = `You are a Japanese language learning assistant for a Traditional Chinese learner.

Create exactly one short, natural sentence at JLPT ${target.level} level.
Required vocabulary: ${target.word}
Required reading: ${target.reading || 'not provided'}
Part of speech: ${target.partOfSpeech}
Traditional Chinese meaning: ${target.meaning || 'not provided'}

Rules:
- The Japanese sentence must contain the required vocabulary, or a normal conjugated form of it.
- kana must be the complete pronunciation of the whole Japanese sentence, with no kanji or Latin letters.
- zh must be an accurate Traditional Chinese translation, not English.
- Keep the sentence concise and appropriate for the requested JLPT level.${correction}`;
      try {
        // Gemini 3.x may spend part of the output budget on reasoning. Use a
        // larger budget and a JSON schema so the final answer is not truncated.
        const response = await this._callStructured(model, {
          prompt,
          responseSchema,
          maxOutputTokens: 1600
        }, apiKey, true, budget);
        if (!response.text) {
          lastErr = this._tagError(new Error('EMPTY_FINAL_RESPONSE'), { model, fallback: true });
          continue;
        }
        if (response.finishReason && response.finishReason !== 'STOP') {
          lastErr = this._tagError(new Error(`MODEL_${response.finishReason}`), { model, fallback: true });
          continue;
        }
        const parsed = parseGeneratedSentenceResponse(response.text);
        const validation = validateGeneratedSentence(parsed, target);
        if (validation.ok) {
          return {
            ...validation.value,
            generation: {
              contract: 2,
              model,
              finishReason: response.finishReason || 'UNSPECIFIED',
              tokenCount: response.tokenCount || 0,
              generatedAt: new Date().toISOString()
            }
          };
        }
        lastErr = this._tagError(new Error('SENTENCE_VALIDATION_FAILED'), { model, fallback: true });
        lastErr.validationReason = validation.reason;
      } catch (err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (this._canTryAnotherModel(err)) { lastErr = err; continue; }
        throw err;
      }
    }
    throw lastErr || new Error('SENTENCE_GENERATION_FAILED');
  },

  async generateDailyVocabulary({ level, rows, count = 1 }) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const normalized = normalizeDailyLearningPreferences({ source: DAILY_LEARNING_SOURCES.LEVEL, level, rows });
    const allowedRows = selectedLearningRows(normalized.rows);
    const rowDescription = allowedRows
      .map(row => `${row.label}（${row.kana}）`).join('、');
    const examplesByRow = {
      a:  { word: '愛', reading: 'あい', romaji: 'ai', partOfSpeech: '名詞', meaning: '愛、愛情' },
      ka: { word: 'ここ', reading: 'ここ', romaji: 'koko', partOfSpeech: '代名詞', meaning: '這裡' },
      sa: { word: '寿司', reading: 'すし', romaji: 'sushi', partOfSpeech: '名詞', meaning: '壽司' },
      ta: { word: '父', reading: 'ちち', romaji: 'chichi', partOfSpeech: '名詞', meaning: '父親' },
      na: { word: '何', reading: 'なに', romaji: 'nani', partOfSpeech: '代名詞', meaning: '什麼' },
      ha: { word: '母', reading: 'はは', romaji: 'haha', partOfSpeech: '名詞', meaning: '母親' },
      ma: { word: '耳', reading: 'みみ', romaji: 'mimi', partOfSpeech: '名詞', meaning: '耳朵' },
      ya: { word: '湯', reading: 'ゆ', romaji: 'yu', partOfSpeech: '名詞', meaning: '熱水' },
      ra: { word: '瑠璃', reading: 'るり', romaji: 'ruri', partOfSpeech: '名詞', meaning: '琉璃' },
      wa: { word: '輪', reading: 'わ', romaji: 'wa', partOfSpeech: '名詞', meaning: '環、輪' }
    };
    const promptExample = { ...examplesByRow[allowedRows[0]?.id || 'a'], level: normalized.level };
    const prompt = `You are selecting daily Japanese vocabulary for a Traditional Chinese learner.

Target level: JLPT ${normalized.level}
Allowed kana rows for the ENTIRE reading: ${rowDescription}
Number of words: ${count}

Choose ${count} useful, non-duplicate Japanese words commonly taught around JLPT ${normalized.level}. EVERY pronounced kana in the full reading MUST belong to one of the allowed rows, not only the first kana. A reading containing even one kana from an unselected row is invalid. Small っ and the long-vowel mark ー are neutral modifiers; other small kana belong to their corresponding row. For example, たべる is invalid when ら行 is not selected because る belongs to ら行. When several rows are selected, distribute the words across them as evenly as practical. Avoid names, brands, obsolete words, particles by themselves, and words substantially outside the target level.

Return ONLY a JSON array with exactly ${count} objects and no markdown:
${JSON.stringify([promptExample])}

Requirements:
- word: normal Japanese spelling (kanji/kana as commonly written)
- reading: full hiragana reading
- every kana in reading must be covered by the allowed rows above
- romaji: Hepburn-style lowercase romaji
- partOfSpeech: Traditional Chinese label
- meaning: concise Traditional Chinese meaning
- level: exactly ${normalized.level}`;
    const responseSchema = {
      type: 'ARRAY',
      minItems: count,
      maxItems: count,
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          reading: { type: 'STRING' },
          romaji: { type: 'STRING' },
          partOfSpeech: { type: 'STRING' },
          meaning: { type: 'STRING' },
          level: { type: 'STRING' }
        },
        required: ['word', 'reading', 'romaji', 'partOfSpeech', 'meaning', 'level'],
        propertyOrdering: ['word', 'reading', 'romaji', 'partOfSpeech', 'meaning', 'level']
      }
    };
    let best = [];
    let lastError = null;
    const budget = this._shortTaskBudget();
    for (const model of this._shortTaskModels()) {
      try {
        const response = await this._callStructured(model, {
          prompt,
          responseSchema,
          maxOutputTokens: 1400
        }, apiKey, true, budget);
        if (!response.text) {
          lastError = this._tagError(new Error('EMPTY_FINAL_RESPONSE'), { model, fallback: true });
          continue;
        }
        if (response.finishReason && response.finishReason !== 'STOP') {
          lastError = this._tagError(new Error(`MODEL_${response.finishReason}`), { model, fallback: true });
          continue;
        }
        const parsed = parseDailyVocabularyResponse(response.text, { level: normalized.level, rows: normalized.rows, limit: count });
        if (parsed.length === count) return parsed;
        for (const word of parsed) {
          if (!best.some(item => item.word === word.word && item.reading === word.reading)) best.push(word);
          if (best.length === count) return best;
        }
        lastError = this._tagError(new Error('AI_OUTPUT_INVALID'), { model, fallback: true });
      } catch (error) {
        if (error.message === 'NETWORK_ERROR') throw error;
        if (this._canTryAnotherModel(error)) { lastError = error; continue; }
        throw error;
      }
    }
    throw lastError || new Error('AI_OUTPUT_INVALID');
  },

  async testConnection() {
    // Use the exact sentence schema and semantic validator used by the home
    // card. A trivial {ok:true} response gave a false success when real
    // sentence generation failed. This probe never writes to learning history.
    const result = await this.generateSentence({
      english: '猫', reading: 'ねこ', romaji: 'neko',
      partOfSpeech: '名詞', chinese: '貓', level: 'N5'
    });
    return { model: result.generation.model, validated: 'sentence', saved: false };
  },


  async translateReadingArticle(article, words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const cleanArticle = String(article || '').trim();
    if (!cleanArticle) throw new Error('NO_ARTICLE');
    const wordList = (Array.isArray(words) ? words : []).slice(0, 5).map((w, i) => {
      const en = String(w.english || w.word || '').trim();
      const zh = String(w.chinese || '').trim();
      return `${i + 1}. ${en}: ${zh || '請依文章脈絡翻譯'}`;
    }).filter(Boolean).join('\n');
    const prompt = `Translate the full Japanese reading passage into natural Traditional Chinese for Taiwan learners.

Japanese passage:
${cleanArticle}

Target vocabulary and preferred Chinese meanings:
${wordList}

Requirements:
- Translate EVERY sentence from beginning to end. Do not summarize, shorten, skip, or stop early.
- Keep the original sentence order and meaning.
- Use the preferred Chinese meanings for the target vocabulary when they fit the passage.
- Output ONLY the complete Traditional Chinese translation.
- Do not add explanations, markdown, title, bullet points, or extra notes.`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15, maxOutputTokens: 2400 }
    });

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const zh = String(raw || '')
          .replace(/^\s*```(?:text|markdown)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .replace(/^\s*(?:ZH|Chinese|Translation|中文翻譯|翻譯)\s*[:：]\s*/i, '')
          .trim();
        if (zh) return zh;
        lastErr = new Error('PARSE_ERROR');
      } catch (err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },


  async generateReadingQuiz(words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const cleanWords = (Array.isArray(words) ? words : []).slice(0, 5).map((w, i) => ({
      index: i + 1,
      english: String(w.english || '').trim(),
      partOfSpeech: String(w.partOfSpeech || '').trim(),
      chinese: String(w.chinese || '').trim()
    })).filter(w => w.english);
    if (cleanWords.length < 5) throw new Error('NOT_ENOUGH_WORDS');

    const wordList = cleanWords.map(w => `${w.index}. "${w.english}" (${w.partOfSpeech || '語彙'}: ${w.chinese || '請依脈絡判斷'})`).join('\n');
    const prompt = `You are a Japanese reading-test generator for Traditional Chinese learners at ${DB.getJlptLevel?.() || 'JLPT N5'} level.

Selected vocabulary words:
${wordList}

Create a short, natural Japanese reading passage and a closest-meaning multiple-choice quiz.

Respond ONLY with a single valid JSON object. No markdown fences, no explanation, no text before or after JSON.
Required JSON format:
{
  "article": "Natural Japanese passage, about 180-300 Japanese characters. Use every selected vocabulary item exactly as written at least once.",
  "questions": [
    {"word":"selected vocabulary item", "correctSynonym":"one correct Japanese meaning or paraphrase", "options":["Japanese option A", "Japanese option B", "Japanese option C"]}
  ]
}

Rules:
- article must be natural Japanese and no more than 450 Japanese characters.
- questions must contain exactly 5 items, one item for each selected vocabulary word.
- options must contain exactly 3 short Japanese options.
- exactly one option must be the correct synonym, and it must equal correctSynonym.
- the other two options must be plausible Japanese distractors but NOT equivalent meanings.
- Do not translate the article.
- Use everyday vocabulary and short sentences suitable for the selected JLPT level.`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.55, maxOutputTokens: 1800 }
    });

    const extractJSON = (raw) => {
      let text = String(raw || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };
    const normalizeQuestion = (q, wordObj) => {
      const correct = String(q?.correctSynonym || '').trim();
      const options = Array.isArray(q?.options) ? q.options.map(o => String(o || '').trim()).filter(Boolean) : [];
      const unique = [...new Map(options.map(option => [option.toLocaleLowerCase(), option])).values()];
      if (!correct || unique.length !== 3 || unique.filter(option => option.toLocaleLowerCase() === correct.toLocaleLowerCase()).length !== 1) return null;
      return {
        word: wordObj.english,
        wordId: wordObj.id || '',
        chinese: wordObj.chinese || '',
        partOfSpeech: wordObj.partOfSpeech || '',
        correctSynonym: correct,
        options: unique.sort(() => Math.random() - 0.5)
      };
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error('PARSE_ERROR: no JSON'); continue; }
        const parsed = JSON.parse(jsonStr);
        const article = String(parsed.article || '').trim();
        const articleCharacterCount = Array.from(article.replace(/\s/g, '')).length;
        const missingWords = cleanWords.filter(w => !article.includes(w.english));
        const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
        if (!article || articleCharacterCount > 450 || missingWords.length || rawQuestions.length < 5) {
          lastErr = new Error('PARSE_ERROR: article or quiz does not meet requirements');
          continue;
        }
        const questions = cleanWords.map((cw, i) => {
          const originalWord = words.find(w => normalizeJapaneseAnswer(w.english) === normalizeJapaneseAnswer(cw.english)) || cw;
          const match = rawQuestions.find(q => normalizeJapaneseAnswer(q?.word) === normalizeJapaneseAnswer(cw.english)) || rawQuestions[i] || {};
          return normalizeQuestion(match, originalWord);
        });
        if (questions.every(q => q && q.options.length === 3)) return { article, questions };
        lastErr = new Error('PARSE_ERROR: invalid questions');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error('PARSE_ERROR: ' + err.message); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },

  _isLocationError(err) {
    return /user location is not supported|location.*not supported|region.*not supported|failed_precondition/i.test(String(err?.message || err || ''));
  },

  _isAuthError(err) {
    return /api key|apikey|invalid|permission denied|authentication|unauthenticated/i.test(String(err?.message || err || ''));
  },

  _normalizePos(pos) {
    const map = {
      noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.', conjunction: 'conj.',
      pronoun: 'pron.', auxiliary: 'aux.', numeral: 'num.', interjection: 'interj.'
    };
    const key = String(pos || '').toLowerCase().trim();
    return map[key] || key.replace(/\.$/, '') + (key ? '.' : '');
  },

  async _translateWithPublicService(text) {
    const q = String(text || '').trim();
    if (!q) return '';
    const endpoints = [
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-TW`,
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-CN`
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) continue;
        const data = await res.json();
        const translated = data?.responseData?.translatedText || data?.matches?.find(m => m?.translation)?.translation || '';
        const cleaned = String(translated).replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (cleaned && cleaned.toLowerCase() !== q.toLowerCase()) return cleaned;
      } catch {}
    }
    return '';
  },

  async _lookupWordPublicFallback(word) {
    const cleanWord = String(word || '').trim().toLowerCase();
    if (!cleanWord) return [];
    let dict = null;
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`);
      if (res.ok) dict = await res.json();
    } catch {}

    const entries = [];
    const first = Array.isArray(dict) ? dict[0] : null;
    const phonetic = (first?.phonetic || first?.phonetics?.find(p => p?.text)?.text || '').replace(/^\/+|\/+$/g, '').trim();
    const meanings = Array.isArray(first?.meanings) ? first.meanings : [];
    for (const meaning of meanings.slice(0, 6)) {
      const def = meaning?.definitions?.find(d => d?.definition)?.definition || '';
      const example = meaning?.definitions?.find(d => d?.example)?.example || '';
      const zh = await this._translateWithPublicService(def || cleanWord);
      entries.push({
        english: cleanWord,
        phonetic,
        pos: this._normalizePos(meaning?.partOfSpeech),
        chinese: (zh || await this._translateWithPublicService(cleanWord) || '公開字典查詢結果').replace(/；\s*$/,'').slice(0, 60),
        example: String(example || '').slice(0, 120),
        source: 'public-fallback'
      });
    }

    if (!entries.length) {
      const zh = await this._translateWithPublicService(cleanWord);
      if (zh) entries.push({ english: cleanWord, phonetic: '', pos: '', chinese: zh.slice(0, 60), example: '', source: 'public-fallback' });
    }
    return entries.filter(e => e.english && e.chinese);
  },

  // Look up Japanese vocabulary via AI. Historical field names remain compatible
  // with the existing views: `english` stores Japanese and `phonetic` stores kana.
  async lookupWord(word) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    await this.ensureModelCatalog();
    const prompt = `You are a Japanese dictionary for Traditional Chinese learners. Look up "${word}" and return its useful Japanese senses as a JSON array.

Each element must have these fields:
- "japanese": the standard Japanese spelling
- "reading": the full reading in hiragana
- "romaji": Hepburn romanization without tone marks
- "pos": concise Traditional Chinese part of speech, such as 名詞、五段動詞、一段動詞、い形容詞、な形容詞、副詞、慣用語
- "chinese": concise Traditional Chinese definition (1-3 meanings separated by semicolons, max 30 chars)
- "example": one short natural Japanese example sentence
- "exampleReading": the example sentence's full kana reading
- "jlpt": one of N5, N4, N3, N2, N1, or 未分級

Return ONLY the JSON array. No markdown, no explanation. Example:
[{"japanese":"食べる","reading":"たべる","romaji":"taberu","pos":"一段動詞","chinese":"吃；食用","example":"毎朝パンを食べます。","exampleReading":"まいあさぱんをたべます。","jlpt":"N5"}]

If the input is not valid Japanese vocabulary, return: []`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json'
      }
    });

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        // Strip markdown fences/thinking tags and extract the first JSON array.
        let text = String(raw)
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
          .replace(/^\s*```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .trim();
        const start = text.indexOf('['), end = text.lastIndexOf(']');
        if (start === -1 || end === -1 || end <= start) { lastErr = new Error('PARSE_ERROR'); continue; }
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) {
          return arr.map(item => ({
            english:  String(item.japanese || item.english || word || '').trim(),
            phonetic: String(item.reading || item.phonetic || '').trim(),
            reading:  String(item.reading || item.phonetic || '').trim(),
            romaji:   String(item.romaji || '').trim(),
            pos:      String(item.pos || '').trim(),
            chinese:  String(item.chinese || '').trim(),
            example:  String(item.example || '').trim(),
            exampleReading: String(item.exampleReading || '').trim(),
            jlpt: String(item.jlpt || '未分級').trim()
          })).filter(item => item.english && item.chinese);
        }
        lastErr = new Error('NOT_ARRAY');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        lastErr = err;
      }
    }
    if (this._isLocationError(lastErr)) {
      const e = new Error('REGION_UNSUPPORTED_NO_FALLBACK');
      e.originalMessage = String(lastErr?.message || '');
      throw e;
    }
    throw lastErr || new Error('API_ERROR');
  }
};
}

