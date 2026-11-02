import { describe, expect, it } from "vitest";
import { createUsageMock, filterUsageCalls, groupUsageCalls, usageCsv, usageRange, usageTotal, type UsageCall } from "../credit-usage-ledger.js";
const now=new Date(2026,9,16,12);
const sample=createUsageMock(now);
describe("credit usage projections",()=>{
  it("exports model input shapes instead of invented context titles",()=>{
    for(const call of sample) {
      const input=JSON.parse(call.modelInput);
      if(call.operation==="embedding") {
        expect(input.input).toHaveLength(2);
        expect(input.input.every((text:unknown)=>typeof text==="string")).toBe(true);
      } else {
        expect(input.messages.some((message:{role:string})=>message.role==="user")).toBe(true);
      }
      expect(call.modelInput).not.toContain('项目讨论会议');
      expect(call.modelInput).not.toContain('积分方案讨论');
    }
    const summary=JSON.parse(sample.find(c=>c.operation==="summary")!.modelInput);
    expect(summary.messages[2].content).toContain('CAPTURED AT:');
    expect(summary.messages[2].content).toContain('USER:');
    const evolution=JSON.parse(sample.find(c=>c.operation==="evolution")!.modelInput);
    expect(JSON.parse(evolution.messages[1].content).raw_turns[0].user_text).toBeTruthy();
  });
  it("filters individual calls before aggregation across midnight and deduplicates IDs",()=>{
    const base=sample[0]!;
    const calls:UsageCall[]=[{...base,id:"old",at:new Date(2026,9,15,23,59).toISOString(),credits:3},{...base,id:"new",at:new Date(2026,9,16,0,1).toISOString(),credits:2}];
    const filtered=filterUsageCalls([...calls,calls[1]!,{...calls[1]!,id:"pending",status:"processing"}],"agent",usageRange("2026-10-16","2026-10-16")!,now);
    expect(groupUsageCalls(filtered)).toHaveLength(1);
    expect(groupUsageCalls(filtered)[0]!.credits).toBe(2);
    expect(filtered).toHaveLength(1);
  });
  it("groups memory by local date, operation and model rather than processing task",()=>{
    const base=sample.find(c=>c.source==="memory")!;
    const rows=groupUsageCalls([base,{...base,id:"same",requestId:"another-task"},{...base,id:"model",model:"another-model"},{...base,id:"op",operation:"summary"},{...base,id:"date",at:new Date(2026,9,15,12).toISOString()}]);
    expect(rows).toHaveLength(4);
    expect(rows.find(r=>r.calls.length===2)?.credits).toBe(base.credits*2);
  });
  it("keeps model totals and zero-credit title requests auditable",()=>{
    const selected=filterUsageCalls(sample,"agent",usageRange("2026-10-10","2026-10-16")!,now);
    const rows=groupUsageCalls(selected);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every(r=>r.calls.length===1 && r.models.length===1)).toBe(true);
    expect(rows).toHaveLength(selected.length);
    expect(rows.some(r=>r.operation==="title" && r.credits===0)).toBe(true);
    expect(Math.round(rows.reduce((s,r)=>s+r.credits,0)*100)/100).toBe(usageTotal(selected));
  });
  it("validates calendar dates and excludes future requests",()=>{
    expect(usageRange("2026-02-30","2026-03-02")).toBeNull();
    expect(usageRange("2026-10-17","2026-10-16")).toBeNull();
    const next={...sample[0]!,at:new Date(now.getTime()+1000).toISOString()};
    expect(filterUsageCalls([next],"agent",usageRange("2026-10-16","2026-10-16")!,now)).toHaveLength(0);
  });
  it("exports Unicode, quotes, multiline prompts, zeros and neutralizes formulas",()=>{
    const csv=usageCsv(["请求","积分"],[["会议\n\"摘要\",测试",0],["=HYPERLINK(\"x\")",2]]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"会议\n""摘要"",测试","0"');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
  });
});
