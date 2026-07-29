-- =====================================================================
-- 9100-radar — SSD 제품 귀책 판정 + 리스크 등급 컬럼 추가 (Phase 3)
-- Supabase SQL Editor 에 전체 붙여넣기 → RUN
--
-- 목적: FA(불량 분석) 관점의 감별 판정을 사례마다 저장한다.
--   attrib      : ssd(제품 귀책 의심) | platform | mixed | user_env | unknown
--   attrib_conf : 판정 확신도 0~1
--   attrib_why  : 판정 근거 1줄 (한국어)
--   risk_score  : 심각도×증거×귀책×확산세 자동 계산 점수
--   risk_grade  : P0 | P1 | WATCH | INFO
-- 여러 번 실행해도 안전 (if not exists)
-- =====================================================================

alter table public.cases add column if not exists attrib      text;
alter table public.cases add column if not exists attrib_conf numeric(3,2);
alter table public.cases add column if not exists attrib_why  text;
alter table public.cases add column if not exists risk_score  numeric(6,2);
alter table public.cases add column if not exists risk_grade  text;

-- 완료 메시지
do $$ begin raise notice '✅ 귀책·리스크 컬럼 추가 완료 (attrib, attrib_conf, attrib_why, risk_score, risk_grade)'; end $$;
