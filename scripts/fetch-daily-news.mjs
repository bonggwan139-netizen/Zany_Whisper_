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
// 각 분야별 3개씩 총 9개 RSS 피드
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
 * Title만 기반으로 5~8문장 한국어 요약 생성 (입력 텍스트 부족 시)
 */
async function generateTitleBasedSummary(title) {
  const hasApiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0;
  
  if (!hasApiKey) {
    // Fallback: OpenAI 없을 때
    return `${title} 관련 소식입니다.`;
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are an expert Korean journalist. Based on an article title, write a brief 5-8 sentence Korean summary that explains what this news might be about. Write naturally as if you are a news editor summarizing the news story. Use a single paragraph format. Do not use meta-expressions like "이 기사는" or "해당 뉴스에서". Keep it objective and factual.`
        },
        {
          role: 'user',
          content: `Please write a 5-8 sentence Korean summary based on this article title:

Title: ${title}

Format your response as JSON: { "summary": "summary text here" }`
        }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);
    return (parsed.summary || `${title} 관련 뉴스입니다.`).trim();
  } catch (err) {
    return `${title} 관련 소식입니다.`;
  }
}

/**
 * OpenAI를 사용한 번역 및 요약 생성
 * 에세이 형식: 8-12줄 단일 문단, 자연스러운 한국어
 */
async function translateAndSummarize(article) {
  const hasApiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0;

  // 입력 텍스트 우선순위: content > description > title
  let inputText = (article.content || article.description || '').trim();
  
  // 입력 텍스트가 너무 짧으면 (100자 미만) title 기반 요약 사용
  if (!inputText || inputText.length < 100) {
    const summary = await generateTitleBasedSummary(article.title);
    return {
      titleKo: article.title, // fallback: 원문 제목
      summary
    };
  }

  if (!hasApiKey) {
    // OpenAI 없을 때 fallback 요약
    return {
      titleKo: article.title,
      summary: generateFallbackSummary(inputText)
    };
  }

  try {
    // HTML 태그 제거
    inputText = inputText.replace(/<[^>]*>/g, '').trim();

    const textToProcess = `
Title: ${article.title}
Content: ${inputText.substring(0, 1000)}
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
4. Format: Single paragraph only (ONE continuous text, no bullets, no line breaks, no array)
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

The summary must be returned as a SINGLE CONTINUOUS PARAGRAPH with NO line breaks within the text.`
        },
        {
          role: 'user',
          content: `Please translate the title to Korean and write an essay-style summary in Korean based on the following article:

${textToProcess}

Requirements:
- Summary must be 8-12 lines in ONE continuous paragraph
- Natural journalist writing style
- SINGLE PARAGRAPH ONLY - do not include line breaks, bullets, or arrays
- Objective and factual tone

Format your response as JSON: { "titleKo": "translated title in Korean", "summary": "complete summary paragraph here with no line breaks" }`
        }
      ],
      temperature: 0.3,
      max_tokens: 600
    });

    const content = response.choices[0].message.content;
    const parsed = JSON.parse(content);

    // 혹시 summary에 줄바꿈이 포함되어 있으면 공백으로 통일
    const cleanSummary = (parsed.summary || generateFallbackSummary(inputText))
      .trim()
      .replace(/\n\n+/g, ' ')
      .replace(/\n/g, ' ');

    return {
      titleKo: parsed.titleKo || article.title,
      summary: cleanSummary
    };
  } catch (err) {
    console.warn(`⚠️  OpenAI API error:`, err.message);
    return {
      titleKo: article.title,
      summary: generateFallbackSummary(inputText)
    };
  }
}

/**
 * Fallback 요약: 텍스트를 자연스러운 문단으로 정렬 (5~8문장)
 * 절대 placeholder나 "[정보 제한]" 같은 마크를 포함하지 않음
 */
function generateFallbackSummary(text) {
  // HTML 태그 제거
  let cleanText = text.replace(/<[^>]*>/g, '').trim();
  
  // 첫 800자 사용
  cleanText = cleanText.substring(0, 800);
  
  // 문장 분할
  const sentences = cleanText
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 8); // 최대 8문장
  
  if (sentences.length === 0) {
    return '뉴스 내용을 확인해주세요.';
  }
  
  // 자연스러운 문단으로 연결 (절대 placeholder 추가 금지)
  let summary = sentences.join(' ');
  
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

  // Source별 통계
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
    
    // 통계 출력
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
