#!/usr/bin/env node

import axios from 'axios';
import { load as cheerioLoad } from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(__dirname, '../src/data/marketcap-top10.json');

// 크롤링 대상 URL
const KOREA_MARKET_URL = 'https://finance.naver.com/sise/entSiseMarketcap.naver';
// US: 마켓워치 top 100 companies (데이터-기반 접근)
// 참고: 실시간 크롤링이 어려운 경우 기본값으로 지속 업데이트
const US_MARKET_URL = 'https://companiesmarketcap.com/usa/largest-companies-by-market-cap/';

// 기본값 - 크롤링 실패 시 사용할 데이터
const DEFAULT_KR = [
  { rank: 1, company: 'Samsung Electronics' },
  { rank: 2, company: 'SK Hynix' },
  { rank: 3, company: 'NAVER' },
  { rank: 4, company: 'Kakao' },
  { rank: 5, company: 'Hyundai Motor' },
  { rank: 6, company: 'LG Electronics' },
  { rank: 7, company: 'POSCO Holdings' },
  { rank: 8, company: 'Samsung SDI' },
  { rank: 9, company: 'Samsung SDS' },
  { rank: 10, company: 'SK Telecom' }
];

const DEFAULT_US = [
  { rank: 1, company: 'Apple Inc.' },
  { rank: 2, company: 'Microsoft Corporation' },
  { rank: 3, company: 'Saudi Aramco' },
  { rank: 4, company: 'Alphabet Inc.' },
  { rank: 5, company: 'Amazon.com Inc.' },
  { rank: 6, company: 'Tesla Inc.' },
  { rank: 7, company: 'Berkshire Hathaway Inc.' },
  { rank: 8, company: 'Nvidia Corporation' },
  { rank: 9, company: 'Meta Platforms Inc.' },
  { rank: 10, company: 'Broadcom Inc.' }
];

/**
 * 한국 시총 TOP10 크롤링
 */
async function fetchKoreanMarketCap() {
  try {
    console.log('🇰🇷 한국 시총 TOP10 크롤링 중...');
    
    const response = await axios.get(KOREA_MARKET_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const $ = cheerioLoad(response.data);
    const companies = [];

    // 테이블의 각 행을 파싱
    $('table tbody tr').slice(0, 10).each((idx, row) => {
      const cells = $(row).find('td');
      if (cells.length > 1) {
        const rank = idx + 1;
        const company = $(cells[1]).text().trim() || $(cells[0]).text().trim();
        
        if (company) {
          companies.push({ rank, company });
        }
      }
    });

    if (companies.length >= 10) {
      console.log(`✅ 한국 TOP10 크롤링 성공: ${companies.length}개`);
      return companies.slice(0, 10);
    }
  } catch (error) {
    console.warn('⚠️  한국 시총 크롤링 실패:', error.message);
  }

  console.log('📌 기본값 사용: 한국 TOP10');
  return DEFAULT_KR;
}

/**
 * 미국 시총 TOP10 크롤링 (companiesmarketcap.com)
 */
async function fetchUSMarketCap() {
  try {
    console.log('🇺🇸 미국 시총 TOP10 크롤링 중...');
    
    const response = await axios.get(US_MARKET_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 15000
    });

    const $ = cheerioLoad(response.data);
    const companies = [];

    // companiesmarketcap.com 테이블 구조:
    // tr에서 기업명 추출 (보통 두 번째 td 또는 첫 번째 링크)
    $('table tbody tr').each((idx, row) => {
      if (companies.length >= 10) return;
      
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        // 기업명은 보통 두 번째 셀 또는 링크 텍스트
        const link = $(row).find('a').first();
        let companyName = link.text().trim();
        
        // 링크가 없으면 텍스트 추출
        if (!companyName) {
          companyName = $(cells[1]).text().trim();
        }
        
        // 공백과 줄바꿈 정리
        companyName = companyName.split('\n')[0].trim();
        
        // 검증
        if (companyName &&
            companyName.length > 2 &&
            !companyName.match(/^[\^&]/) &&
            !companyName.match(/^[\d\s,\.\-$%+]+$/) &&
            !companyName.match(/^(Rank|Company|Price|Change|%|Market)/i)) {
          
          companies.push({
            rank: companies.length + 1,
            company: companyName
          });
        }
      }
    });

    // 지수 심볼 검증
    const hasIndexSymbols = companies.some(c => c.company && c.company.match(/^[\^&]/));
    if (hasIndexSymbols) {
      throw new Error('Contains index symbols (^), not company names');
    }

    if (companies.length >= 10) {
      console.log(`✅ 미국 TOP10 크롤링 성공: ${companies.length}개 (${companies[0].company} ~ ${companies[9].company})`);
      return companies.slice(0, 10);
    } else {
      throw new Error(`Only ${companies.length} companies extracted (need 10)`);
    }
  } catch (error) {
    console.warn('⚠️  미국 시총 크롤링 실패:', error.message);
  }

  console.log('📌 기본값 사용: 미국 TOP10');
  return DEFAULT_US;
}

/**
 * 데이터 저장
 */
async function saveMarketCapData() {
  try {
    const krData = await fetchKoreanMarketCap();
    const usData = await fetchUSMarketCap();

    const outputData = {
      updatedAt: new Date().toISOString(),
      KR: krData,
      US: usData
    };

    // src/data 디렉토리가 없으면 생성
    const dir = path.dirname(dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // (a) 기존 파일이 있으면 prev로 백업
    const prevPath = dataPath.replace('.json', '.prev.json');
    if (fs.existsSync(dataPath)) {
      const existingData = fs.readFileSync(dataPath, 'utf-8');
      fs.writeFileSync(prevPath, existingData);
      console.log(`📌 이전 데이터 백업: ${prevPath}`);
    }

    // (b) 새 데이터 저장
    fs.writeFileSync(dataPath, JSON.stringify(outputData, null, 2));
    
    console.log(`\n✅ Market cap 데이터 업데이트 완료`);
    console.log(`   현재: ${dataPath}`);
    console.log(`   이전: ${prevPath}`);
    console.log(`   업데이트 시간: ${outputData.updatedAt}`);
    console.log(`   한국: ${krData.length}개 | 미국: ${usData.length}개`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ 데이터 저장 오류:', error.message);
    process.exit(1);
  }
}

// 실행
saveMarketCapData();
