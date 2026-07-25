-- =====================================================================
-- 9100-radar — 클러스터별·날짜별 제보 건수 집계 뷰 (Phase 3)
-- Supabase SQL Editor 에 전체 붙여넣기 → RUN
--
-- 목적: 대시보드 막대그래프를 실제 수집 데이터로 그리기 위함.
--       원문(posts)은 계속 비공개로 두고, "날짜 + 건수" 숫자만 공개한다.
-- 시간대: Asia/Seoul — 수집 스케줄(12:00/24:00 KST) 및 대시보드 표기와 일치시킴
-- 여러 번 실행해도 안전 (create or replace)
-- =====================================================================

create or replace view public.cluster_daily as
select
  c.cluster                                                        as cluster_id,
  (coalesce(p.posted_at, p.collected_at) at time zone 'Asia/Seoul')::date as day,
  count(*)::int                                                    as n
from public.posts p
join public.cases c on c.id = p.case_id
where c.cluster is not null
group by 1, 2;

-- 뷰는 소유자 권한으로 동작(security_invoker = false)하므로
-- anon 키로도 집계 결과만 읽을 수 있고, posts 원문에는 여전히 접근 불가.
alter view public.cluster_daily set (security_invoker = false);

-- 공개(anon) 열쇠에 읽기 권한 부여
grant select on public.cluster_daily to anon, authenticated;

-- 완료 메시지
do $$ begin raise notice '✅ cluster_daily 뷰 갱신 완료 (Asia/Seoul 기준)'; end $$;
