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
    { name: 'Nature News', url: 'https://www.nature.com/nature/current_issue/rss/' },
    { name: 'Phys.org', url: 'https://phys.org/rss-feed/' }
  ],
  economy: [
    { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'Financial Times', url: 'https://feeds.ft.com/home/rss' },
    { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' }
  ]
};

const ARTICLES_PER_SOURCE = 5;

/**
 * RSS 피드에서 기사 수집
 */
async function fetchArticlesFromRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const articles = feed.items.slice(0, ARTICLES_PER_SOURCE).map((item, idx) => ({
      id: `${Date.now()}-${idx}`,
      title: item.title || 'No title',
      description: item.description || item.summary || '',
      link: item.link || '',
      content: item.content || '',
      pubDate: item.pubDate || new Date().toISOString()
    }));
    
    console.log(`    ✅ ${source.name}: ${articles.length}개 수집`);
    return articles;
  } catch (err) {
    console.error(`    ❌ ${source.name}: RSS 파싱 실패 - ${err.message}`);
    return [];
  }
}

/**
 * OpenAI를 사용한 번역 및 요약 생성
 * 에세이 형식: 8-12줄 단일 문단, 자연스러운 한국어
 */
async function translateAndSummarize(article) {
  const hasApiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0;

  if (!hasApiKey) {
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
          content: `You are an expert Korean journalist specializing in news summarization. Your task is to:

1. Translate the article title accurately to natural, idiomatic Korean
2. Write a concise essay-style summary in Korean (8-12 lines)
3. Structure the summary: key context → background → main content → implication/significance
4. Format: Single paragraph only (no bullet points, no line breaks within the summary text)
5. Language guidelines:
   - Write naturally like a professional journalist, not a machine
   - Keep sentences short and direct for clarity
   - Avoid unnecessary repetition
   - Do not use overly formal or stiff language
   - Never start with meta-expressions like "이 기사는...", "해당 뉴스에 따르면...", "보도에 의하면..."
   - Use active voice when possible
   - Connect ideas smoothly for good flow
6. Content guidelines:
   - Include the key facts and main points
   - Explain briefly why this matters (implication/significance)
   - Maintain strict objectivity - no personal opinions, judgments, or excessive evaluation
   - Avoid promotional or sensationalist language
   - Never add subjective phrases like "흥미롭게도", "놀랍게도" at the end

The summary should read as if written by a professional news editor - natural, coherent, and informative.`
        },
        {
          role: 'user',
          content: `Please translate the title to Korean and write an essay-style summary in Korean based on the following article information:

${textToProcess}

Requirements:
- Summary must be 8-12 lines in one continuous paragraph
- Natural journalist writing style
- No bullet points or special formatting
- Objective and factual tone
- Include the key context, background, main content, and significance

Format your response as JSON: { "titleKo": "translated title in Korean", "summary": "complete summary paragraph here" }`
        }
      ],
      temperature: 0.3,
      max_tokens: 600
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      titleKo: parsed.titleKo || article.title,
      summary: (parsed.summary || generateFallbackSummary(article.description)).trim()
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
 * Fallback 요약: Description을 자연스러운 문단형으로 정렬 (8-12줄)
 * 기자처럼 작성된 흐름으로 연결
 */
function generateFallbackSummary(description) {
  // HTML 태그 제거
  let text = description.replace(/<[^>]*>/g, '').trim();
  
  // 첫 800자 사용 (더 긴 요약을 위해)
  text = text.substring(0, 800);
  
  // 문장 분할 (마침표, 물음표, 느낌표 기준)
  const sentences = text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 12); // 최대 12문장
  
  // 부족하면 빈 문장 제거 (더미 추가하지 않음)
  if (sentences.length === 0) {
    return '기사 요약정보가 제한적입니다.';
  }
  
  // 자연스러운 문단으로 연결
  // 첫 3-4 문장은 그대로, 나머지는 약간 간결하게
  let summary = sentences.slice(0, 4).join(' ');
  
  if (sentences.length > 4) {
    const restSentences = sentences
      .slice(4)
      .map(s => s.length > 50 ? s.substring(0, 50) + '...' : s)
      .join(' ');
    summary += ' ' + restSentences;
  }
  
  // 마침표로 끝나도록 정리
  summary = summary.trim();
  if (!summary.endsWith('.')) {
    summary += '.';
  }
  
  return summary;
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

  // 통계용 객체
  const stats = {};

  for (const [category, sources] of Object.entries(NEWS_SOURCES)) {
    console.log(`\n📰 ${category.toUpperCase()} 뉴스 수집 중...`);
    stats[category] = {};

    for (const source of sources) {
      const articles = await fetchArticlesFromRSS(source);
      stats[category][source.name] = articles.length;

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

  return { data: result, stats };
}

/**
 * 메인: 뉴스 수집 및 저장
 */
async function main() {
  try {
    console.log('🌍 Daily News 수집 시작...\n');

    const { data: newsData, stats } = await fetchAllNews();

    // 파일 저장 (덮어쓰기)
    fs.writeFileSync(dataPath, JSON.stringify(newsData, null, 2), 'utf-8');
    
    // 상세한 통계 출력
    console.log('\n' + '='.repeat(60));
    console.log('📊 NEWS COLLECTION SUMMARY');
    console.log('='.repeat(60));

    let totalArticles = 0;
    for (const [category, sources] of Object.entries(stats)) {
      const categoryTotal = Object.values(sources).reduce((a, b) => a + b, 0);
      totalArticles += categoryTotal;
      
      console.log(`\n[${category.toUpperCase()}] 총 ${categoryTotal}개 수집`);
      for (const [sourceName, count] of Object.entries(sources)) {
        const status = count > 0 ? '✅' : '⚠️ ';
        console.log(`  ${status} ${sourceName}: ${count}개`);
      }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`✅ 전체 수집 완료: ${totalArticles}개`);
    console.log(`   저장 위치: ${dataPath}`);
    console.log(`   업데이트 시간: ${newsData.updatedAt}`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ 뉴스 수집 중 오류:', error.message);
    process.exit(1);
  }
}

main();
