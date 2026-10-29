// Match the renderer's deduplication key across both candidate arrays.
const CANDIDATE_COUNT = (column: string) => `(SELECT count(DISTINCT CASE
  WHEN coalesce(json_extract(c.value,'$.refId'),'')!='' THEN coalesce(json_extract(c.value,'$.refKind'),'memory')||':'||json_extract(c.value,'$.refId')
  ELSE coalesce(json_extract(c.value,'$.refKind'),'')||'|'||coalesce(json_extract(c.value,'$.tier'),'')||'|'||coalesce(json_extract(c.value,'$.memoryLayer'),'')||'|'||coalesce(json_extract(c.value,'$.content'),json_extract(c.value,'$.snippet'),json_extract(c.value,'$.summary'),'') END)
  FROM (SELECT value FROM json_each(${column},'$.candidates') WHERE type='object'
    UNION ALL SELECT value FROM json_each(${column},'$.filtered') WHERE type='object') c)`;
export const projectPanelLogSql = (column: string) => `CASE WHEN json_valid(${column}) THEN json_object(
 'skillId',json_extract(${column},'$.skillId'),'skill_id',json_extract(${column},'$.skill_id'),
 'kind',json_extract(${column},'$.kind'),'phase',json_extract(${column},'$.phase'),
 'name',substr(json_extract(${column},'$.name'),1,180),'title',substr(json_extract(${column},'$.title'),1,180),
 'summary',substr(json_extract(${column},'$.summary'),1,180),'reason',substr(json_extract(${column},'$.reason'),1,180),
 'content',substr(json_extract(${column},'$.content'),1,180),'query',substr(json_extract(${column},'$.query'),1,180),
 'stats',json_object('ranked',max(coalesce(json_extract(${column},'$.stats.ranked'),0),${CANDIDATE_COUNT(column)}),
   'finalReturned',coalesce(json_extract(${column},'$.stats.llmFilter.kept'),json_extract(${column},'$.stats.finalReturned'),json_array_length(${column},'$.filtered'),0)),
 'details',json(CASE WHEN json_array_length(${column},'$.details')>0 THEN json_array(json_object(
   'role',json_extract(${column},'$.details[0].role'),'traceId',json_extract(${column},'$.details[0].traceId'),
   'spanId',json_extract(${column},'$.details[0].spanId'),'summary',substr(json_extract(${column},'$.details[0].summary'),1,180),
   'spanGoal',substr(coalesce(json_extract(${column},'$.details[0].spanGoal'),json_extract(${column},'$.details[0].span_goal')),1,180),
   'query',substr(json_extract(${column},'$.details[0].query'),1,180),'content',substr(json_extract(${column},'$.details[0].content'),1,180))) ELSE '[]' END)
 ) ELSE '{}' END`;
