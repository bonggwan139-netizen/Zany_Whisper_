#!/usr/bin/env node

import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../src/data/daily-news.json');

const parser = new Parser({
  customFields: {
    item: [['content:encoded', 'content']]
  }
});

const USER_AGENT = 'Mozilla/5.0 (compatible; ZanyWhisperBot/1.0; +https://bonggwan139-netizen.github.io/Zany_Whisper_/)';
const TIMEOUT = 12000; // ms
const RETRIES = 2;
const ITEMS_PER_SOURCE = 5;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const HAS_OPENAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);

// Fixed working RSS sources per category
const SOURCES = {
  World: [
    { name: 'BBC World', rss: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'The Guardian', rss: 'https://www.theguardian.com/world/rss' },
    { name: 'Al Jazeera', rss: 'https://www.aljazeera.com/xml/rss/all.xml' }
  ],
  Science: [
    { name: 'NASA Breaking News', rss: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
    { name: 'ScienceDaily', rss: 'https://www.sciencedaily.com/rss/all.xml' },
    { name: 'Phys.org', rss: 'https://phys.org/rss-feed/' }
  ],
  Economy: [
    { name: 'CNBC Top News', rss: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch Top Stories', rss: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
    { name: 'The Economist', rss: 'https://www.economist.com/the-world-this-week/rss.xml' }
  ]
};

// Local fallback summary generator: 5-8 short sentences, single paragraph
function localSummaryFromText(text, minSentences = 5, maxSentences = 8) {
  if (!text || typeof text !== 'string') return '요약할 내용이 부족합니다.';
  // sanitize
  const cleaned = text.replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  // split into rough sentences
  const raw = cleaned.split(/[.?!]+/).map(s => s.trim()).filter(Boolean);
  const take = Math.min(Math.max(minSentences, 1), maxSentences);
  const sentences = raw.slice(0, take);

  // If not enough sentences, synthesize from title-like fragments
  while (sentences.length < minSentences) {
    sentences.push(sentences.length ? sentences[sentences.length - 1] : cleaned);
    if (sentences.length >= maxSentences) break;
  }

  let paragraph = sentences.join('. ');
  if (!paragraph.endsWith('.')) paragraph += '.';
  // ensure short clear sentences: collapse multiple spaces
  paragraph = paragraph.replace(/\s+/g, ' ').trim();
  return paragraph;
}

async function fetchWithRetries(url, options = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) {
        lastErr = `status ${res.status}`;
        // try next attempt
        continue;
      }
      const text = await res.text();
      return { ok: true, status: res.status, text };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err && err.name === 'AbortError' ? 'timeout' : (err && err.message ? err.message : String(err));
      // continue to retry
    }
  }
  return { ok: false, error: lastErr };
}

async function fetchAndParseRSS(rssUrl) {
  const res = await fetchWithRetries(rssUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
  });

  if (!res.ok) return { ok: false, reason: res.error || 'fetch failed' };

  try {
    const feed = await parser.parseString(res.text);
    const items = Array.isArray(feed.items) ? feed.items.slice(0, ITEMS_PER_SOURCE) : [];
    return { ok: true, status: res.status, items };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

async function generateOpenAISummary(title, text) {
  try {
    const prompt = `You are a professional Korean news editor. Given the title and a short article excerpt, translate the title into natural Korean and write an essay-style single-paragraph summary (8-12 short lines worth) in Korean. Do NOT use bullets or numbered lists. Do not use meta phrases like "이 기사는". Output JSON: {"titleKo": "...", "summary": "..."}`;

    const inputText = `Title: ${title}\nContent: ${text.substring(0, 1000)}`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: inputText }],
      temperature: 0.3,
      max_tokens: 600
    });

    const content = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    if (!content) throw new Error('empty response');

    // Expect JSON. Try to parse; if fails, fallback to raw text.
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Attempt to extract JSON substring
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    }

    if (parsed && parsed.titleKo && parsed.summary) {
      const summary = parsed.summary.replace(/\n+/g, ' ').trim();
      return { titleKo: parsed.titleKo.trim(), summary };
    }

    // As a last resort, use raw content as paragraph
    const raw = content.replace(/\n+/g, ' ').trim();
    return { titleKo: title, summary: raw };
  } catch (err) {
    throw err;
  }
}

async function processSource(category, source) {
  console.log(`Processing ${category} - ${source.name} -> ${source.rss}`);
  const notePrefix = `${category} / ${source.name}`;
  const out = { source: source.name, rss: source.rss, items: [] };
  const res = await fetchAndParseRSS(source.rss);
  if (!res.ok) {
    console.warn(`${notePrefix}: failed -> ${res.reason || res.error || 'unknown'}`);
    return { out, count: 0, error: res.reason || res.error || 'fetch failed' };
  }

  const rawItems = res.items || [];
  for (const it of rawItems) {
    // input priority: content (content:encoded) -> contentSnippet -> description -> title
    const inputText = (it.content || it.contentSnippet || it.description || it.summary || '').toString().trim();
    const title = (it.title || '').toString().trim();
    const link = it.link || it.guid || '';
    const pubDate = it.pubDate || new Date().toISOString();

    let translatedTitle = title;
    let summary = '';

    try {
      if (HAS_OPENAI && inputText && inputText.length >= 100) {
        try {
          const ai = await generateOpenAISummary(title, inputText);
          translatedTitle = ai.titleKo || title;
          summary = ai.summary || '';
        } catch (err) {
          console.warn(`${notePrefix}: OpenAI failed -> ${err.message || String(err)}; falling back to local summary`);
          translatedTitle = title;
          summary = localSummaryFromText(inputText, 5, 8);
        }
      } else {
        // no OpenAI or input too short -> local fallback
        translatedTitle = title;
        const fallbackSource = inputText || title;
        summary = localSummaryFromText(fallbackSource, 5, 8);
      }
    } catch (err) {
      translatedTitle = title;
      summary = localSummaryFromText(inputText || title, 5, 8);
    }

    // ensure single paragraph string
    summary = (summary || '').replace(/\n+/g, ' ').trim();

    out.items.push({
      source: source.name,
      sourceUrl: source.rss,
      title,
      translatedTitle,
      summary,
      url: link,
      publishedAt: new Date(pubDate).toISOString()
    });
  }

  console.log(`${notePrefix}: collected ${out.items.length} items`);
  return { out, count: out.items.length, error: null };
}

async function main() {
  console.log('Daily News v1 - fetch start');
  const result = { updatedAt: new Date().toISOString(), categories: { world: [], science: [], economy: [] }, errors: [] };

  for (const [category, sources] of Object.entries(SOURCES)) {
    const targetKey = category.toLowerCase();
    // ensure exactly the number of configured sources (SOURCES[category]) are represented
    for (const source of sources) {
      try {
        const { out, count, error } = await processSource(category, source);
        // attach error into out if present
        if (error) out.error = error;
        // ensure items array exists
        out.items = Array.isArray(out.items) ? out.items : [];
        result.categories[targetKey].push(out);
        if (error) result.errors.push({ category: targetKey, source: source.name, rss: source.rss, reason: error });
        // avoid hammering
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        console.warn(`${category} / ${source.name}: unexpected error -> ${reason}`);
        result.categories[targetKey].push({ source: source.name, rss: source.rss, items: [], error: reason });
        result.errors.push({ category: targetKey, source: source.name, rss: source.rss, reason });
      }
    }
    // If for any reason the array length is less than configured, pad with placeholders
    while (result.categories[targetKey].length < sources.length) {
      const idx = result.categories[targetKey].length;
      const s = sources[idx];
      result.categories[targetKey].push({ source: s.name, rss: s.rss, items: [], error: 'no data' });
    }
  }

  // write file (overwrite)
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Saved daily news to ${DATA_PATH}`);
  } catch (err) {
    console.error('Failed to write data file:', err && err.message ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  console.log('Daily News v1 - fetch complete');
}

// Run
main().catch(err => {
  console.error('Fatal error:', err && err.message ? err.message : String(err));
  process.exit(1);
});
