#!/usr/bin/env node

import Parser from 'rss-parser';
import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(__dirname, '../src/data/daily-news.json');

const parser = new Parser({
  customFields: {
    item: [['content:encoded', 'content']]
  }
});

// OpenAI 클라이언트
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

// RSS 출처 설정 (안정적인 사이트 기준)
const NEWS_SOURCES = {
  world: [
    { name: 'BBC World', url: 'http://feeds.bbc.co.uk/news/world/rss.xml' },
    { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'Al Jazeera English', url: 'https://www.aljazeera.com/xml/rss/all.xml' }
  ],
  science: [
    { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
    { name: 'Nature News', url: 'https://www.nature.com/nature/current_issue/rss/index.html' },
    { name: 'Phys.org', url: 'https://phys.org/rss-feed/' }
  ],
  economy: [
    { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' }
  ]
};

const ARTICLES_PER_SOURCE = 5;

/**
 * RSS 피드에서 기사 수집
 */
async function fetchArticlesFromRSS(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    const articles = feed.items.slice(0, ARTICLES_PER_SOURCE).map((item, idx) => ({
      id: `${Date.now()}-${idx}`,
      title: item.title || 'No title',
      description: item.description || item.summary || '',
      link: item.link || '',
      content: item.content || '',
      pubDate: item.pubDate || new Date().toISOString()
    }));
    return articles;
  } catch (err) {
    console.warn(`⚠️  RSS fetch failed for ${feedUrl}:`, err.message);
    return [];
  }
}

/**
 * OpenAI를 사용한 번역 및 요약 생성
 * fallback: 번역=원문 제목, 요약=description을 10줄로 정리
 */
async function translateAndSummarize(article) {
  const hasApiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0;

  if (!hasApiKey) {
    console.warn(`⚠️  OPENAI_API_KEY not set. Using fallback for: "${article.title}"`);
    return {
      titleKo: article.title,
      summary: generateFallbackSummary(article.description)
    };
  }

  try {
    const textToProcess = `
Title: ${article.title}
Description: ${article.description}
Content (if available): ${article.content.substring(0, 500)}
    `.trim();

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a professional translator and summarizer. Translate titles to Korean and create concise, structured summaries in Korean. For summaries, format as exactly 10 bullet points. Be accurate and preserve meaning.'
        },
        {
          role: 'user',
          content: `Translate the title to Korean and create a summary of exactly 10 bullet points in Korean:

${textToProcess}

Format your response as JSON: { "titleKo": "...", "summary": "point1\\npoint2\\n..." }`
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      titleKo: parsed.titleKo || article.title,
      summary: parsed.summary || generateFallbackSummary(article.description)
    };
  } catch (err) {
    console.warn(`⚠️  OpenAI API error:`, err.message);
    return {
      titleKo: article.title,
      summary: generateFallbackSummary(article.description)
    };
  }
}

/**
 * Fallback 요약: description을 10줄로 줄바꿈 정리
 */
function generateFallbackSummary(description) {
  // HTML 태그 제거
  let text = description.replace(/<[^>]*>/g, '').trim();
  // 첫 500자만 사용
  text = text.substring(0, 500);
  // 문장 단위로 분할하고 10개 항목으로 정렬
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).slice(0, 10);
  // 부족하면 더미 항목으로 채움
  while (sentences.length < 10) {
    sentences.push('[정보 제한]');
  }
  return sentences.map(s => s.trim()).join('\n');
}

/**
 * 모든 뉴스 카테고리 수집
 */
async function fetchAllNews() {
  const result = {
    updatedAt: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    world: [],
    science: [],
    economy: []
  };

  for (const [category, sources] of Object.entries(NEWS_SOURCES)) {
    console.log(`\n📰 ${category.toUpperCase()} 뉴스 수집 중...`);

    for (const source of sources) {
      console.log(`  → ${source.name}...`);
      const articles = await fetchArticlesFromRSS(source.url);

      for (const article of articles) {
        const { titleKo, summary } = await translateAndSummarize(article);
        result[category].push({
          source: source.name,
          titleEn: article.title,
          titleKo,
          summary,
          link: article.link,
          pubDate: article.pubDate
        });
      }

      // API 호출 제한 방지
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return result;
}

/**
 * 메인: 뉴스 수집 및 저장
 */
async function main() {
  try {
    console.log('🌍 Daily News 수집 시작...\n');

    const newsData = await fetchAllNews();

    // 파일 저장 (덮어쓰기)
    fs.writeFileSync(dataPath, JSON.stringify(newsData, null, 2), 'utf-8');
    console.log(`\n✅ 뉴스 데이터 저장 완료: ${dataPath}`);
    console.log(`   세계: ${newsData.world.length}개, 과학: ${newsData.science.length}개, 경제: ${newsData.economy.length}개`);
  } catch (error) {
    console.error('❌ 뉴스 수집 중 오류:', error.message);
    process.exit(1);
  }
}

main();
